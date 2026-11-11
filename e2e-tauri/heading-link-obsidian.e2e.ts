// ---------------------------------------------------------------------------
// Real-backend heading link (#6277 F4): Edit as Markdown writes a `((ULID))`
// to a heading whose text is unique on its page as `[[Title#Heading]]`, and
// the buffer, edited and saved, stores the ref to the same heading.
//
// Only the real backend writes names in the buffer and reads them back on save
// (`get_page_buffer` / `apply_page_source`); the mock's buffer keeps raw ids.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  clickPageSourceButton,
  invoke,
  navigateTo,
  openNewPage,
  openPageSource,
  pageSourceLines,
  pageSourceText,
  reopenPageByTitle,
  runScopedMarker,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TITLE = runScopedMarker('wdio-hlink-page')
const HEADING = runScopedMarker('wdio-hlink-heading')
const REF = runScopedMarker('wdio-hlink-ref')

const row = (marker: string) => $(`[data-testid="sortable-block"]*=${marker}`)

/** Leave for the journal and come back to the page `title`, so the rows are the backend's. */
async function reopen(title: string, marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await row(marker).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Rewrite the open buffer's line holding `marker` with `edit`, then save and wait for source mode to close. */
async function saveLine(
  source: Awaited<ReturnType<typeof openPageSource>>,
  marker: string,
  edit: (text: string) => string,
): Promise<void> {
  await setPageSourceLines(
    (await pageSourceLines()).map(({ text, id }) => ({
      id,
      text: text.includes(marker) ? edit(text) : text,
    })),
  )
  await clickPageSourceButton('Save')
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })
}

describe('Agaric real-backend heading link (#6277 F4) @editor @markdown', () => {
  it('writes a ref to a unique heading as [[Title#Heading]] and saves it back as that ref', async () => {
    await waitForAppReady()
    await openNewPage(TITLE)
    await typeMarkerVerified(HEADING)
    await reopen(TITLE, HEADING)
    const headingId = await row(HEADING).getAttribute('data-block-id')
    await saveLine(await openPageSource([HEADING]), HEADING, (text) => `## ${text}`)
    await reopen(TITLE, HEADING)
    expect((await invoke<{ content: string }>('get_block', { blockId: headingId })).content).toBe(
      `## ${HEADING}`,
    )

    await openNewPage()
    await typeMarkerVerified(REF)
    await reopen('Untitled', REF)
    const refId = await row(REF).getAttribute('data-block-id')
    // The ref, written as it is stored.
    await saveLine(await openPageSource([REF]), REF, (text) => `${text} ((${headingId}))`)
    await row(REF).$('[data-testid="block-ref-chip"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    await reopen('Untitled', REF)
    const link = `[[${TITLE}#${HEADING}]]`
    const source = await openPageSource([REF])
    expect(await pageSourceText()).toContain(`${REF} ${link}`)
    await saveLine(source, REF, (text) => text.replace(link, `${link} edited`))

    await reopen('Untitled', REF)
    await row(REF).$('[data-testid="block-ref-chip"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
    const stored = await invoke<{ content: string }>('get_block', { blockId: refId })
    expect(stored.content).toBe(`${REF} ((${headingId})) edited`)
  })
})
