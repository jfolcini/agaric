// ---------------------------------------------------------------------------
// Real-backend: a line break inside a block survives a typo fix (#5160 D2).
//
// Bug class (X1): a block stored as two lines (`hello\nworld`, from Source,
// import or a Shift+Enter) was split into two sibling blocks by the first
// blur after any edit, because the editor read the stored `\n` as a paragraph
// separator while Rust reads it as a line inside the block. The mock-backed
// lanes model none of the Rust reading, so this is the one surface where the
// stored bytes come from the real `edit_block` and are read back by the real
// backend (AGENTS.md § Testing invariants, rule 4).
//
// Flow: type a first line, Shift+Enter, a second line, commit (Enter creates
// the next block; the source block keeps both lines). Re-enter the block,
// append a suffix at the end, commit again. Navigate away and back, then
// assert ONE static block carries both lines and the suffix, and no block
// carries the second line alone.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

// #3334 — run-scoped, so a leftover row from an earlier run cannot satisfy the
// durable read. Two markers, one per line, so a split would be visible as a
// second block holding only LINE2.
const LINE1 = runScopedMarker('wdio-line-break-one')
const LINE2 = runScopedMarker('wdio-line-break-two')
const SUFFIX = '-fixed'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** The committed block holding `text` must be the ONE block, carrying both lines. */
async function expectOneTwoLineBlock(expectedSecondLine: string): Promise<void> {
  const block = blockStaticByMarker(LINE1)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const text = await block.getText()
  expect(text).toContain(LINE1)
  expect(text).toContain(expectedSecondLine)
  // The second line lives in that same block: exactly one static row holds it.
  const secondLineRows = await blockStaticsByMarker(LINE2)
  expect(secondLineRows).toHaveLength(1)
  expect(await secondLineRows[0]?.getText()).toContain(LINE1)
}

describe('Agaric real-backend line break inside a block (#5160 D2)', () => {
  it('keeps a two-line block as one block through a typo fix and a view round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // 1. Line one, Shift+Enter, line two. The second line is typed without the
    //    read-back helper: the editor's text now spans two lines, so an exact
    //    read-back of the whole editor would never equal LINE2 alone.
    await openJournalBlockEditor()
    await typeMarkerVerified(LINE1)
    await browser.keys(['Shift', 'Enter'])
    await browser.keys(LINE2.split(''))
    await browser.waitUntil(async () => (await $(EDITOR).getText()).includes(LINE2), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `line two ${JSON.stringify(LINE2)} never appeared in the editor`,
    })
    // Enter commits the block (edit_block, not a split) and moves the roving
    // editor to a fresh sibling; Escape leaves that empty sibling.
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await expectOneTwoLineBlock(LINE2)

    // 2. Re-enter the committed block, fix a "typo" at the very end, commit.
    await blockStaticByMarker(LINE1).click()
    const editor = $(EDITOR)
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['Control', 'End'])
    await browser.keys(SUFFIX.split(''))
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await expectOneTwoLineBlock(`${LINE2}${SUFFIX}`)

    // 3. Navigate away and back — the durable read through the real backend.
    await navigateTo('Pages')
    await navigateTo('Journal')
    await expectOneTwoLineBlock(`${LINE2}${SUFFIX}`)
  })
})
