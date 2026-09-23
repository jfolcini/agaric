// ---------------------------------------------------------------------------
// Real-backend Duplicate of a multi-line block (#5140 Phase 3a).
//
// Duplicate used to serialize the subtree to an indented-markdown outline and
// paste it back, and the paste split on every newline: a two-line code block
// came back as four blocks (both fences and each line). It is now one
// `duplicate_block` command that copies rows, so the copy is ONE code block
// holding both lines. The Playwright twin (`e2e/block-duplicate.spec.ts`)
// runs against the mock; this spec is the one with the real backend in it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const FIRST = runScopedMarker('wdio-dup-first')
const SECOND = runScopedMarker('wdio-dup-second')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(SECOND).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

describe('Agaric real-backend Duplicate (#5140 Phase 3a)', () => {
  it('copies a two-line code block as ONE code block', async () => {
    await waitForAppReady()
    await openNewPage()

    // `/code` turns the empty first block into a code block.
    await $(EDITOR).click()
    await browser.keys('/code'.split(''))
    const codeItem = $('[data-testid="suggestion-item"]*=Insert code block')
    await codeItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await codeItem.click()
    await $('[data-testid="block-editor"] pre').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // Inside a code block Enter is a newline, not a new block. The second line
    // is paced like `typeVerified`'s retry, since its read-back covers only a
    // whole editor.
    await typeMarkerVerified(FIRST)
    await browser.keys(['Enter'])
    for (const ch of SECOND) {
      await browser.keys([ch])
      await browser.pause(40)
    }
    await browser.waitUntil(
      async () => {
        const text = await $(EDITOR).getText()
        return text.includes(FIRST) && text.includes(SECOND)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the two code lines never landed in the editor' },
    )

    // The sidebar click blurs and commits the block.
    await reopenTheNewPage()

    const original = blockStaticByMarker(SECOND)
    await original.click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'Shift', 'j'])
    // The original keeps the editor, so the copy is the only static row.
    await browser.waitUntil(async () => (await blockStaticsByMarker(SECOND)).length === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+Shift+J did not render a copy of the code block',
    })

    await reopenTheNewPage()
    // A row is `sortable-block` whether it renders static or holds the editor,
    // which the re-opened page may hand back to the original.
    const rowsHoldingSecond = () => $$(`[data-testid="sortable-block"]*=${SECOND}`).getElements()
    await browser.waitUntil(async () => (await rowsHoldingSecond()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold two copies of the code block',
    })
    // Exactly the original and ONE copy, each a single code block with both
    // lines: the old outline paste left a row per line beside them.
    const rows = await $$('[data-testid="sortable-block"]').getElements()
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const text = await row.getText()
      expect(text).toContain(FIRST)
      expect(text).toContain(SECOND)
      await expect(row.$('pre')).toBeExisting()
    }
  })
})
