// ---------------------------------------------------------------------------
// Real-backend block ref as an Obsidian link (#6277 F2): Edit as Markdown
// writes a `((ULID))` to a block of another page as `[[Title#^ULID]]`, and the
// buffer, edited and saved, stores the ref to the same block.
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

const TITLE = runScopedMarker('wdio-bref-page')
const TARGET = runScopedMarker('wdio-bref-target')
const REF = runScopedMarker('wdio-bref-ref')

const row = (marker: string) => $(`[data-testid="sortable-block"]*=${marker}`)

/** Leave for the journal and come back to the page `title`, so the rows are the backend's. */
async function reopen(title: string, marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await row(marker).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Rewrite the open buffer's line holding `REF` with `edit`, then save and wait for source mode to close. */
async function saveRefLine(
  source: Awaited<ReturnType<typeof openPageSource>>,
  edit: (text: string) => string,
): Promise<void> {
  await setPageSourceLines(
    (await pageSourceLines()).map(({ text, id }) => ({
      id,
      text: text.includes(REF) ? edit(text) : text,
    })),
  )
  await clickPageSourceButton('Save')
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })
}

describe('Agaric real-backend block ref as an Obsidian link (#6277 F2) @editor @markdown', () => {
  it('writes a ref to another page as [[Title#^id]] and saves it back as that ref', async () => {
    await waitForAppReady()
    await openNewPage(TITLE)
    await typeMarkerVerified(TARGET)
    await reopen(TITLE, TARGET)
    const targetId = await row(TARGET).getAttribute('data-block-id')

    await openNewPage()
    await typeMarkerVerified(REF)
    await reopen('Untitled', REF)
    const refId = await row(REF).getAttribute('data-block-id')
    // The ref, written as it is stored.
    await saveRefLine(await openPageSource([REF]), (text) => `${text} ((${targetId}))`)
    await row(REF).$('[data-testid="block-ref-chip"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    await reopen('Untitled', REF)
    const link = `[[${TITLE}#^${targetId}]]`
    const source = await openPageSource([REF])
    expect(await pageSourceText()).toContain(`${REF} ${link}`)
    await saveRefLine(source, (text) => text.replace(link, `${link} edited`))

    await reopen('Untitled', REF)
    await row(REF).$('[data-testid="block-ref-chip"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
    const stored = await invoke<{ content: string }>('get_block', { blockId: refId })
    expect(stored.content).toBe(`${REF} ((${targetId})) edited`)
  })
})
