// ---------------------------------------------------------------------------
// Real-backend labelled link (#5160 D9): `[[Page|label]]` typed in a block
// stores `[[ULID|label]]`, the chip shows the label after a durable-read hop,
// and Edit as Markdown writes `[[Page|label]]` and reads an edited label back.
//
// Only the real backend renders the source buffer with names and resolves them
// on save (`render_page_source` / `apply_page_source` in
// commands/pages/markdown.rs); the mock's buffer keeps raw ids. The Playwright
// twin for the typing half is `e2e/link-labels.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  setPageSource,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-lbl')
const TARGET = runScopedMarker('wdio-lbl-target')
const LABEL = runScopedMarker('wdio-lbl-shown')
const EDITED = runScopedMarker('wdio-lbl-edited')

const chipWith = (label: string) =>
  $(`[data-testid="sortable-block"]*=${MARKER}`).$(`[data-testid="block-link-chip"]=${label}`)

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${MARKER}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

describe('Agaric real-backend labelled link (#5160 D9)', () => {
  it('stores the label, shows it, and round-trips it through Edit as Markdown', async () => {
    await waitForAppReady()
    await openNewPage()
    // The `]]` closes the input rule, which turns the text into a chip, so the
    // verified typing stops before it.
    await typeMarkerVerified(`${MARKER} [[${TARGET}|${LABEL}`)
    // WebKit coalesces two identical keys sent together (`typeVerified`), so
    // the `]]` goes one key at a time.
    await browser.keys([']'])
    await browser.pause(40)
    await browser.keys([']'])
    await chipWith(LABEL).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await reopenTheNewPage()
    await chipWith(LABEL).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await chipWith(LABEL).getAttribute('title')).toBe(TARGET)

    const source = await openPageSource([MARKER])
    const base = await source.getValue()
    expect(base).toContain(`[[${TARGET}|${LABEL}]]`)
    await setPageSource(base.replace(`|${LABEL}]]`, `|${EDITED}]]`))
    const save = source.parentElement().$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    await reopenTheNewPage()
    await chipWith(EDITED).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await chipWith(EDITED).getAttribute('title')).toBe(TARGET)
    expect(await $$(`[data-testid="block-link-chip"]=${LABEL}`).length).toBe(0)
  })
})
