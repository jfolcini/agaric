// ---------------------------------------------------------------------------
// Real-backend paste of multi-line text into the middle of a block (#5160
// Phase 2b, D4).
//
// The editor sends the text and the block's halves around the cursor, and
// `paste_blocks` splices them in one transaction: the block becomes its first
// half plus the first pasted block, the rest follow as blocks (a heading
// owning what comes after it, D16), and the second half ends the last one.
// The mock models the grammar only approximately, and its reload cannot show
// what the editor's own draft flush does to the block after the paste, so only
// this lane proves the splice is what the backend keeps: the tree is read after
// a navigation round-trip. The toast's Undo is exercised first, on the live
// page, since leaving the page drops its undo stack. The Playwright twin
// (`e2e/paste-spliced-5160.spec.ts`) runs against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const HEAD = runScopedMarker('wdio-splice-head')
const TAIL = runScopedMarker('wdio-splice-tail')
const LEAD = runScopedMarker('wdio-splice-lead')
const PLAN = runScopedMarker('wdio-splice-plan')
const STEP = runScopedMarker('wdio-splice-step')
const DETAIL = runScopedMarker('wdio-splice-detail')
const LAST = runScopedMarker('wdio-splice-last')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** An LLM answer's shape: a lead-in, a heading, a numbered step with a detail, a sign-off. */
const ANSWER = [
  `${LEAD} first`,
  '',
  `## ${PLAN}`,
  '',
  `1. ${STEP}`,
  `   - ${DETAIL}`,
  '',
  LAST,
].join('\n')

/** Put the caret between HEAD and TAIL in the focused block. */
async function caretBeforeTail(): Promise<void> {
  await browser.keys(['End'])
  for (let i = 0; i < TAIL.length; i++) await browser.keys(['ArrowLeft'])
}

/** Paste `text` as `text/plain` into the focused editor. */
async function pastePlain(text: string): Promise<void> {
  await browser.execute(
    (selector: string, value: string) => {
      const editor = document.querySelector(selector)
      const data = new DataTransfer()
      data.setData('text/plain', value)
      editor?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    EDITOR,
    text,
  )
}

/** The row holding `marker`: its outline level and its text. */
async function row(marker: string): Promise<{ level: string | null; text: string }> {
  const block = $(`[data-testid="sortable-block"]*=${marker}`)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = await block.getAttribute('data-block-id')
  return {
    // SortableBlockWrapper.tsx renders the row <li> with aria-level = depth + 1.
    level: await $(`li[data-block-id="${id}"]`).getAttribute('aria-level'),
    text: await block.getText(),
  }
}

describe('Agaric real-backend spliced paste (#5160 D4)', () => {
  it('splices an answer into a block, undoes it in one step, and keeps the splice durably', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(`${HEAD} ${TAIL}`)
    await caretBeforeTail()

    // The toast's Undo takes the whole paste back: the blocks and the join.
    await pastePlain(ANSWER)
    await waitForToast('Pasted 5 blocks')
    const undo = $('[data-sonner-toast]').$('button=Undo')
    await undo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await undo.click()
    await expectAbsent(`[data-testid="sortable-block"]*=${PLAN}`, 'the pasted heading after Undo')
    await browser.waitUntil(
      async () => (await blockStaticByMarker(HEAD).getText()).includes(`${HEAD} ${TAIL}`),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Undo did not restore the block text' },
    )

    // Paste again, and read what the backend kept after a round-trip.
    await blockStaticByMarker(HEAD).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await caretBeforeTail()
    await pastePlain(ANSWER)
    await $(`[data-testid="sortable-block"]*=${PLAN}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')

    const anchor = await row(HEAD)
    expect(anchor.level).toBe('1')
    expect(anchor.text).toContain(`${HEAD} ${LEAD} first`)
    expect(anchor.text).not.toContain(TAIL)
    expect((await row(PLAN)).level).toBe('1')
    expect((await row(STEP)).level).toBe('2')
    expect((await row(DETAIL)).level).toBe('3')
    const last = await row(LAST)
    expect(last.level).toBe('2')
    expect(last.text).toContain(`${LAST}${TAIL}`)
  })
})
