// ---------------------------------------------------------------------------
// Real-backend source mode (#5140 Phase 4b).
//
// The page kebab's "Edit as Markdown" swaps the block tree for the page's
// markdown buffer (`get_page_source`), and Save writes the whole buffer back
// through `apply_page_source`. One save here reorders two blocks, edits one
// and deletes one; the re-opened page must hold exactly that, with the edited
// block keeping its id through its `^ID` anchor. The Playwright twin
// (`e2e/page-source-edit.spec.ts`) runs against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const FIRST = runScopedMarker('wdio-src-first')
const SECOND = runScopedMarker('wdio-src-second')
const THIRD = runScopedMarker('wdio-src-third')
const EDITED = runScopedMarker('wdio-src-edited')
const SOURCE = '[data-testid="page-source-editor"]'

const rowsWith = (marker: string) => $$(`[data-testid="sortable-block"]*=${marker}`).getElements()

/** Enter moves the editor to a new, empty sibling. */
async function nextBlock(): Promise<void> {
  await browser.keys(['Enter'])
  await $('[data-testid="block-editor"] p.is-editor-empty').waitForExist({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Enter did not open an empty block',
  })
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${marker}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Replace the source buffer in one input event, as a paste lands. Typed keys
 * lose repeated characters in this WebView (see `typeMarkerVerified`), and the
 * `^ID` anchors are full of them.
 */
async function setSource(text: string): Promise<void> {
  await browser.execute(
    (selector: string, value: string) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(selector)
      if (textarea === null) throw new Error('setSource: no source editor')
      // The prototype setter goes around React's own value tracking, so the
      // input event reads as a change.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        value,
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    },
    SOURCE,
    text,
  )
}

describe('Agaric real-backend source mode (#5140 Phase 4b)', () => {
  it('one save reorders, edits and deletes blocks, durably', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await nextBlock()
    await typeMarkerVerified(SECOND)
    await nextBlock()
    await typeMarkerVerified(THIRD)
    // The sidebar click blurs and commits the last block.
    await reopenTheNewPage(THIRD)
    const firstId = await $(`[data-testid="sortable-block"]*=${FIRST}`).getAttribute(
      'data-block-id',
    )
    const thirdId = await $(`[data-testid="sortable-block"]*=${THIRD}`).getAttribute(
      'data-block-id',
    )

    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    const editAsMarkdown = $('[role="menuitem"]*=Edit as Markdown')
    await editAsMarkdown.waitForClickable({ timeout: ACTION_TIMEOUT })
    await editAsMarkdown.click()
    const source = $(SOURCE)
    await browser.waitUntil(
      async () => {
        const text = await source.getValue()
        return [FIRST, SECOND, THIRD].every((marker) => text.includes(marker))
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the source editor never held the three blocks' },
    )

    // Each block is its bullet line and the lines under it, anchor included.
    const base = await source.getValue()
    const blocks = base.trimEnd().split(/\n(?=[ \t]*- )/)
    const blockWith = (marker: string): string => {
      const block = blocks.find((b) => b.includes(marker))
      if (block === undefined) throw new Error(`no block holds ${marker} in ${base}`)
      return block
    }
    await setSource(`${blockWith(THIRD)}\n${blockWith(FIRST).replace(FIRST, EDITED)}\n`)
    const save = source.parentElement().$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    // A row is `sortable-block` whether it renders static or holds the editor,
    // which the re-opened page may hand to a previously focused block.
    await reopenTheNewPage(EDITED)
    await browser.waitUntil(async () => (await rowsWith(THIRD)).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the third block once',
    })
    expect((await rowsWith(EDITED)).length).toBe(1)
    await expectAbsent(`[data-testid="sortable-block"]*=${FIRST}`, 'the pre-edit text')
    await expectAbsent(`[data-testid="sortable-block"]*=${SECOND}`, 'the deleted block')
    const order = await $$('[data-testid="sortable-block"]').map((row) =>
      row.getAttribute('data-block-id'),
    )
    expect(order).toEqual([thirdId, firstId])
  })
})
