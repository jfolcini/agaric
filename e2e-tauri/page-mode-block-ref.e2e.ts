// ---------------------------------------------------------------------------
// Real-backend: a `((ref))` to a block edited in page mode still resolves (#5691).
//
// A `((ref))` holds its target's id. Page mode keeps a block's id on its text
// through every edit (`src/editor/token-ids.ts`, shared with Edit as Markdown,
// and `src/editor/page-mode/page-block-ids.ts`): Enter at the
// start of the block moves the id down with the text and leaves the new, empty
// block above it a new one. Had the id stayed on the empty half, or had the
// save deleted the block and created its text again, the ref would point at
// an empty block or a deleted one.
//
// The ref is written with Edit as Markdown, which reads `((ULID))` as a block
// ref; the target is then edited in page mode: a block split off above it,
// text typed into it, and an indent.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  openPageSource,
  pageSourceButton,
  pageSourceLines,
  reopenPageByTitle,
  runScopedMarker,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import { chooseEditMode, pageModeBlocks, pageModeCaret, typeInPageMode } from './page-mode'

const REF = runScopedMarker('wdio-pm-ref')
const TARGET = runScopedMarker('wdio-pm-target')

const row = (marker: string) => $(`[data-testid="sortable-block"]*=${marker}`)

describe('Agaric real-backend block refs to a page-mode edit (#5691)', () => {
  it('a ((ref)) to a block split, typed into and indented in page mode still resolves to it', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(REF)
    await enterBlankSibling()
    await typeMarkerVerified(TARGET)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await row(TARGET).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const targetId = await row(TARGET).getAttribute('data-block-id')

    // The ref, written into the first block's text.
    const source = await openPageSource([REF, TARGET])
    await setPageSourceLines(
      (await pageSourceLines()).map(({ text, id }) => ({
        id,
        text: text.includes(REF) ? `${text} ((${targetId}))` : text,
      })),
    )
    const save = pageSourceButton('Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })
    await row(REF).$('[data-testid="block-ref-chip"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    await chooseEditMode('Page')
    // By id, not text: the ref's chip shows the target's text in the first block too.
    const at = (await pageModeBlocks()).findIndex((block) => block.id === targetId)
    expect(at).toBe(1)
    await pageModeCaret(at, 0)
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === at + 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Enter never split off a block above the target',
    })
    // Enter leaves the cursor on the text it moved down; type into the new block above.
    await pageModeCaret(at, 0)
    await typeInPageMode('x', at, 'x')
    await pageModeCaret(at + 1, 'end')
    await typeInPageMode(' edited', at + 1, `${TARGET} edited`)
    await browser.keys(['Tab'])
    await browser.waitUntil(async () => (await pageModeBlocks())[at + 1]?.depth === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Tab never moved the target under the new block',
    })
    // The id stayed on the target's text, not on the new block above it.
    expect((await pageModeBlocks())[at + 1]?.id).toBe(targetId)
    await chooseEditMode('Blocks')

    // Re-queried: the target under its own id, live, with its new text.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    const target = $(`[data-testid="sortable-block"][data-block-id="${targetId}"]`)
    await target.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await target.getText()).toContain(`${TARGET} edited`)
    const chip = row(REF).$('[data-testid="block-ref-chip"]')
    await chip.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await chip.getAttribute('class')).not.toContain('block-ref-deleted')
    expect(await chip.getText()).toContain(TARGET)
  })
})
