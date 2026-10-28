// ---------------------------------------------------------------------------
// Real-backend page mode back from Edit as Markdown (#5691).
//
// Text typed in page mode is saved as Edit as Markdown opens. Closing the
// buffer without a write, by Cancel or by Save with nothing changed, brings
// page mode back on the page as saved: the typed text shows, and the next
// edit of that block keeps it rather than writing the page as page mode first
// read it back over it. The re-opened page holds every edit. The Playwright
// twin is in `e2e/page-mode.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  clickPageSourceButton,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import { chooseEditMode, pageModeBlocks, pageModeCaret, typeInPageMode } from './page-mode'

const FIRST = runScopedMarker('wdio-pm-back-first')
const SECOND = runScopedMarker('wdio-pm-back-second')
const BEFORE = runScopedMarker('wdio-pm-back-before')
const AFTER_CANCEL = runScopedMarker('wdio-pm-back-cancel')
const AFTER_SAVE = runScopedMarker('wdio-pm-back-save')

/** Wait until page mode shows `texts`, one per block in order. */
async function pageModeShows(texts: string[], what: string): Promise<void> {
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = (await pageModeBlocks()).map((block) => block.text)
        return JSON.stringify(seen) === JSON.stringify(texts)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: page mode shows ${JSON.stringify(seen)}`)
    })
}

/** The source buffer is closed and page mode is back. */
async function backInPageMode(): Promise<void> {
  await $('[data-testid="page-source-editor"]').waitForExist({
    reverse: true,
    timeout: NAV_TIMEOUT,
  })
  await $('[data-testid="page-mode-editor"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

describe('Agaric real-backend page mode back from Edit as Markdown (#5691) @editor @pages @markdown', () => {
  it('shows the text typed before, after Cancel and after Save with nothing changed, and keeps it', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await enterBlankSibling()
    await typeMarkerVerified(SECOND)
    await chooseEditMode('Page')
    await pageModeShows([FIRST, SECOND], 'opened')

    await pageModeCaret(1, 'end')
    await typeInPageMode(` ${BEFORE}`, 1, `${SECOND} ${BEFORE}`)
    // Opening the buffer saves the text first: the buffer reads it from the backend.
    await openPageSource([`${SECOND} ${BEFORE}`])
    await clickPageSourceButton('Cancel')
    await backInPageMode()
    await pageModeShows([FIRST, `${SECOND} ${BEFORE}`], 'after Cancel')

    await pageModeCaret(1, 'end')
    await typeInPageMode(` ${AFTER_CANCEL}`, 1, `${SECOND} ${BEFORE} ${AFTER_CANCEL}`)
    await openPageSource([`${SECOND} ${BEFORE} ${AFTER_CANCEL}`])
    // Save is off with nothing changed; its key closes the buffer, writing nothing.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement === document.querySelector('[data-testid="page-source-editor"]'),
        ),
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the source buffer never took the focus' },
    )
    await browser.keys(['Control', 's'])
    await backInPageMode()
    await pageModeShows([FIRST, `${SECOND} ${BEFORE} ${AFTER_CANCEL}`], 'after Save')

    await pageModeCaret(1, 'end')
    await typeInPageMode(` ${AFTER_SAVE}`, 1, `${SECOND} ${BEFORE} ${AFTER_CANCEL} ${AFTER_SAVE}`)

    // Read back from the backend: leaving the page saves the text, then open it again.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await pageModeShows(
      [FIRST, `${SECOND} ${BEFORE} ${AFTER_CANCEL} ${AFTER_SAVE}`],
      'the re-opened page',
    )
  })
})
