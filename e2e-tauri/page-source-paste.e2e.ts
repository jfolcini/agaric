// ---------------------------------------------------------------------------
// Real-backend source-mode cut, copy and paste (#5160 phase 5-5b).
//
// The source buffer's own clipboard handlers carry each line's block id: a cut
// line pasted back is a move, a copy is a new block (D15), and lines pasted
// from another page's buffer are new blocks too, their ids dropped on paste,
// so the save warns of no foreign id. Each save here goes through the real
// `apply_page_source`, and every assertion reads the re-opened page. The
// vitest twins are in `src/editor/__tests__/source-buffer.test.ts` and
// `PageSourceEditor.test.tsx`, against the mock.
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
  pageSourceButton,
  pageSourceClipboard,
  pageSourceLines,
  reopenPageByTitle,
  runScopedMarker,
  type SourceLine,
  setPageSourceLines,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const FIRST = runScopedMarker('wdio-paste-first')
const CHILD = runScopedMarker('wdio-paste-kid')
const SECOND = runScopedMarker('wdio-paste-second')
const THIRD = runScopedMarker('wdio-paste-third')
const OTHER_PAGE = runScopedMarker('wdio-paste-other-page')
const OTHER_ONE = runScopedMarker('wdio-paste-other-one')
const OTHER_TWO = runScopedMarker('wdio-paste-other-two')
const OTHER_THREE = runScopedMarker('wdio-paste-other-three')

const rowsWith = (marker: string) => $$(`[data-testid="sortable-block"]*=${marker}`).getElements()

/** The page's block ids, in the order its rows show them. */
function rowIds(): Promise<Array<string | null>> {
  return $$('[data-testid="sortable-block"]').map((row) => row.getAttribute('data-block-id'))
}

async function idOf(marker: string): Promise<string> {
  const id = await $(`[data-testid="sortable-block"]*=${marker}`).getAttribute('data-block-id')
  if (id === null) throw new Error(`the block holding ${marker} has no data-block-id`)
  return id
}

/** The outline level of block `id`'s row. */
function levelOf(id: string): Promise<string | null> {
  return browser.execute(
    (blockId: string) =>
      document
        .querySelector(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
        ?.closest('li[aria-level]')
        ?.getAttribute('aria-level') ?? null,
    id,
  )
}

/** The index of the buffer line holding `marker`. */
function lineWith(lines: SourceLine[], marker: string): number {
  const index = lines.findIndex((line) => line.text.includes(marker))
  if (index === -1) throw new Error(`no buffer line holds ${marker}`)
  return index
}

/** Enter moves the editor to a new, empty sibling. */
async function nextBlock(): Promise<void> {
  await browser.keys(['Enter'])
  await $('[data-testid="block-editor"] p.is-editor-empty').waitForExist({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Enter did not open an empty block',
  })
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenPage(title: string, marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await $(`[data-testid="sortable-block"]*=${marker}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Save the open source buffer and wait for source mode to close. */
async function saveSource(source: ReturnType<typeof $>): Promise<void> {
  const save = pageSourceButton('Save')
  await save.waitForClickable({ timeout: ACTION_TIMEOUT })
  await save.click()
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })
}

describe('Agaric real-backend source-mode cut, copy and paste (#5160 phase 5-5b)', () => {
  let firstId = ''
  let childId = ''
  let secondId = ''
  let thirdId = ''

  it('a line cut and pasted elsewhere in the buffer saves as a move, its child with it', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await nextBlock()
    await typeMarkerVerified(SECOND)
    await nextBlock()
    await typeMarkerVerified(THIRD)
    // The sidebar click blurs and commits the last block.
    await reopenPage('Untitled', THIRD)

    // FIRST gets a child, written as the line under it.
    const setup = await openPageSource([FIRST, SECOND, THIRD])
    const base = await pageSourceLines()
    const first = lineWith(base, FIRST)
    await setPageSourceLines([
      ...base.slice(0, first + 1),
      { text: `  - ${CHILD}`, id: null },
      ...base.slice(first + 1),
    ])
    await saveSource(setup)
    await reopenPage('Untitled', CHILD)
    firstId = await idOf(FIRST)
    childId = await idOf(CHILD)
    secondId = await idOf(SECOND)
    thirdId = await idOf(THIRD)

    // FIRST's line and its child's, line breaks and all, pasted where THIRD starts.
    const source = await openPageSource([FIRST, CHILD, SECOND, THIRD])
    const before = await pageSourceLines()
    const cutFrom = lineWith(before, FIRST)
    const cut = await pageSourceClipboard(
      'cut',
      { line: cutFrom, offset: 0 },
      { line: cutFrom + 2, offset: 0 },
    )
    const third = { line: lineWith(await pageSourceLines(), THIRD), offset: 0 }
    await pageSourceClipboard('paste', third, third, cut)
    await saveSource(source)

    await reopenPage('Untitled', FIRST)
    await browser.waitUntil(async () => (await rowIds()).length === 4, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold its four blocks',
    })
    expect(await rowIds()).toEqual([secondId, firstId, childId, thirdId])
    expect(await levelOf(childId)).toBe('2')
  })

  it('a line copied and pasted saves as a new block next to the original', async () => {
    const source = await openPageSource([FIRST, SECOND, THIRD])
    const lines = await pageSourceLines()
    const second = lineWith(lines, SECOND)
    const copied = await pageSourceClipboard(
      'copy',
      { line: second, offset: 0 },
      { line: second + 1, offset: 0 },
    )
    const next = { line: second + 1, offset: 0 }
    await pageSourceClipboard('paste', next, next, copied)
    await saveSource(source)

    await reopenPage('Untitled', SECOND)
    await browser.waitUntil(async () => (await rowsWith(SECOND)).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the copy beside the original',
    })
    const order = await rowIds()
    expect(order).toHaveLength(5)
    const copyId = order[1]
    expect(typeof copyId).toBe('string')
    expect([firstId, childId, secondId, thirdId]).not.toContain(copyId)
    expect(order).toEqual([secondId, copyId, firstId, childId, thirdId])
  })

  it('lines pasted from another page’s buffer arrive as new blocks, and that page is unchanged', async () => {
    await navigateTo('Pages')
    await typeInputVerified('#new-page-name', OTHER_PAGE)
    await browser.keys(['Enter'])
    await $('[aria-label="Page title"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })
    await typeMarkerVerified(OTHER_ONE)
    await nextBlock()
    await typeMarkerVerified(OTHER_TWO)
    await nextBlock()
    await typeMarkerVerified(OTHER_THREE)
    await reopenPage(OTHER_PAGE, OTHER_THREE)
    const otherIds = await rowIds()
    expect(otherIds).toHaveLength(3)

    // Its first two lines, line breaks and all; the buffer closes unchanged.
    const otherSource = await openPageSource([OTHER_ONE, OTHER_TWO, OTHER_THREE])
    const otherLines = await pageSourceLines()
    const one = lineWith(otherLines, OTHER_ONE)
    const copied = await pageSourceClipboard(
      'copy',
      { line: one, offset: 0 },
      { line: one + 2, offset: 0 },
    )
    expect(copied['text/html']).toContain(otherIds[0])
    const cancel = pageSourceButton('Cancel')
    await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
    await cancel.click()
    await otherSource.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await reopenPage('Untitled', THIRD)
    const source = await openPageSource([THIRD])
    const third = { line: lineWith(await pageSourceLines(), THIRD), offset: 0 }
    await pageSourceClipboard('paste', third, third, copied)
    await saveSource(source)

    // The save warned of no line carrying another page's block.
    await waitForToast('Markdown saved')
    const reports = await $$('[data-sonner-toast]').map((toast) => toast.getText())
    expect(reports.join('\n')).not.toContain('not a block of this page')
    await reopenPage('Untitled', OTHER_TWO)
    await browser.waitUntil(async () => (await rowIds()).length === 7, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the two pasted blocks',
    })
    const pasted = [await idOf(OTHER_ONE), await idOf(OTHER_TWO)]
    for (const id of pasted) expect(otherIds).not.toContain(id)
    expect((await rowIds()).slice(4)).toEqual([...pasted, thirdId])

    await reopenPage(OTHER_PAGE, OTHER_THREE)
    await browser.waitUntil(async () => (await rowIds()).length === 3, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the other page does not hold its three blocks',
    })
    expect(await rowIds()).toEqual(otherIds)
  })
})
