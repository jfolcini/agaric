// ---------------------------------------------------------------------------
// Real-backend block structure keys (#5365).
//
// The mock-lane specs (`block-keyboard-fundamentals`, `block-keyboard-move`)
// read these off the calls sent, not off the outline stored. Here every step
// is checked on the page re-opened from the backend:
//   - Enter mid-text splits the block (`split_block`: a create and an edit in
//     one transaction), and Backspace at the start of the new block merges it
//     back (`merge_blocks`: an edit, a move per child and a delete in one).
//   - One Ctrl+Z takes back a split, and one a merge with the child it moved
//     (#6531): each command's ops are one undo entry.
//   - Ctrl+Shift+ArrowUp, Tab, Shift+Tab and Ctrl+Shift+ArrowDown are
//     `move_block` calls; the order and nesting they store must be the ones
//     shown.
//
// Three tests in one vault, each on its own titled page.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  openNewPageDialog,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

interface Row {
  id: string | null
  text: string
  level: string | null
}

/**
 * Every block row in document order. A row is `sortable-block` whether it
 * renders static or holds the editor; its level is the `aria-level` of its
 * `<li>` (SortableBlockWrapper, depth + 1).
 */
function rows(): Promise<Row[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="sortable-block"]')].map((row) => ({
      id: row.getAttribute('data-block-id'),
      text: row.textContent ?? '',
      level: row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null,
    })),
  )
}

/**
 * Wait until the page shows exactly `expected`, each row written as the
 * markers of `markers` it holds, joined by `+`, then `@` and its level.
 */
async function waitForOutline(markers: string[], expected: string[], what: string): Promise<Row[]> {
  const shape = (row: Row) =>
    `${markers.filter((marker) => row.text.includes(marker)).join('+')}@${row.level}`
  let seen: Row[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await rows()
        return JSON.stringify(seen.map(shape)) === JSON.stringify(expected)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `${what}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen.map(shape))}`,
      )
    })
  return seen
}

/** Create page `title` in the New page dialog; it opens with its first block in the editor. */
async function openNewPageTitled(title: string): Promise<void> {
  await openNewPageDialog()
  await typeInputVerified('#new-page-name', title)
  await browser.keys(['Enter'])
  await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/** Leave page `title` and come back, so the rows are the backend's. */
async function reopen(title: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
}

/** Wait until the focused editor is block `id`'s. */
async function waitForEditorIn(id: string, what: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string, blockId: string) => {
          const editor = document.querySelector(sel)
          return (
            editor !== null &&
            document.activeElement === editor &&
            editor.closest('[data-block-id]')?.getAttribute('data-block-id') === blockId
          )
        },
        EDITOR,
        id,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: what },
  )
}

/** Put the editor in block `id`, clicking its static row unless it already has it. */
async function editBlock(id: string): Promise<void> {
  const inBlock = $(`[data-testid="block-editor"][data-block-id="${id}"] [contenteditable="true"]`)
  if (!(await inBlock.isExisting())) {
    const row = $(`[data-testid="block-static"][data-block-id="${id}"]`)
    await row.waitForClickable({ timeout: ACTION_TIMEOUT })
    await row.click()
  }
  await waitForEditorIn(id, `the editor never opened in block ${id}`)
}

/** Collapse the editor's selection to `offset` characters into its first paragraph. */
async function placeCaret(offset: number): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string, at: number) => {
          // TipTap keeps its editor on the editable element.
          const dom = document.querySelector<
            HTMLElement & {
              editor?: {
                state: { selection: { from: number; empty: boolean } }
                commands: { setTextSelection: (pos: number) => boolean }
              }
            }
          >(sel)
          if (dom?.editor === undefined) return false
          dom.editor.commands.setTextSelection(1 + at)
          const { from, empty } = dom.editor.state.selection
          return empty && from === 1 + at
        },
        EDITOR,
        offset,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `the caret never reached offset ${offset}` },
  )
}

/** Leave the editor, where Ctrl+Z is its own, and press the page's undo. */
async function undoOutsideTheEditor(): Promise<void> {
  await browser.keys(['Escape'])
  await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  await browser.keys(['Control', 'z'])
}

describe('Agaric real-backend block structure keys (#5365) @editor', () => {
  before(waitForAppReady)

  it('Enter mid-text splits a block and Backspace at its start merges it back, durably', async () => {
    const page = runScopedMarker('wdio-split-page')
    const left = runScopedMarker('wdio-split-left')
    const right = runScopedMarker('wdio-split-right')
    const markers = [left, right]
    await openNewPageTitled(page)
    await typeMarkerVerified(`${left} ${right}`)
    const sourceId = (await rows())[0]?.id ?? null
    if (sourceId === null) throw new Error('the typed block has no data-block-id')

    await placeCaret(left.length + 1)
    await browser.keys(['Enter'])
    await waitForOutline(markers, [`${left}@1`, `${right}@1`], 'Enter did not split the block')

    await reopen(page)
    const split = await waitForOutline(
      markers,
      [`${left}@1`, `${right}@1`],
      'the re-opened page does not hold the two halves',
    )
    expect(split[0]?.id).toBe(sourceId)
    const newId = split[1]?.id
    if (newId === null || newId === undefined) throw new Error('the new block has no id')

    await editBlock(newId)
    await placeCaret(0)
    await browser.keys(['Backspace'])
    await waitForOutline(markers, [`${left}+${right}@1`], 'Backspace did not merge the blocks')

    await reopen(page)
    const [merged] = await waitForOutline(
      markers,
      [`${left}+${right}@1`],
      'the re-opened page does not hold the merged block once',
    )
    expect(merged?.id).toBe(sourceId)
    const text = merged?.text ?? ''
    expect(text.indexOf(left)).toBeLessThan(text.indexOf(right))
  })

  it('one Ctrl+Z takes back a split, and one a merge with the child it moved (#6531)', async () => {
    const page = runScopedMarker('wdio-undo-page')
    const left = runScopedMarker('wdio-undo-left')
    const right = runScopedMarker('wdio-undo-right')
    const second = runScopedMarker('wdio-undo-second')
    const child = runScopedMarker('wdio-undo-child')
    const markers = [left, right, second, child]
    const whole = `${left}+${right}@1`
    await openNewPageTitled(page)
    await typeMarkerVerified(`${left} ${right}`)
    // Re-opening saves the typing and starts the page's undo history afresh,
    // so the split is the one entry Ctrl+Z can take.
    await reopen(page)
    const wholeId = (await waitForOutline(markers, [whole], 'the typed block was not stored'))[0]
      ?.id
    if (wholeId === null || wholeId === undefined) throw new Error('the typed block has no id')

    await editBlock(wholeId)
    await placeCaret(left.length + 1)
    await browser.keys(['Enter'])
    await waitForOutline(markers, [`${left}@1`, `${right}@1`], 'Enter did not split the block')
    await undoOutsideTheEditor()
    await waitForOutline(markers, [whole], 'one Ctrl+Z did not take the split back')
    await reopen(page)
    await waitForOutline(markers, [whole], 'the re-opened page does not hold the block whole')

    await editBlock(wholeId)
    const secondId = await enterBlankSibling()
    await typeMarkerVerified(second)
    await enterBlankSibling()
    await typeMarkerVerified(child)
    await browser.keys(['Tab'])
    const nested = [whole, `${second}@1`, `${child}@2`]
    await waitForOutline(markers, nested, 'Tab did not nest the child')
    await reopen(page)
    await waitForOutline(markers, nested, 'the re-opened page does not hold the nested child')

    await editBlock(secondId)
    await placeCaret(0)
    await browser.keys(['Backspace'])
    await waitForOutline(
      markers,
      [`${left}+${right}+${second}@1`, `${child}@2`],
      'Backspace did not merge the block and move its child',
    )
    await undoOutsideTheEditor()
    await waitForOutline(markers, nested, 'one Ctrl+Z did not take the merge back')
    await reopen(page)
    await waitForOutline(markers, nested, 'the re-opened page does not hold the blocks unmerged')
  })

  it('move up, Tab, Shift+Tab and move down store the order and nesting shown', async () => {
    const page = runScopedMarker('wdio-move-page')
    const one = runScopedMarker('wdio-move-one')
    const two = runScopedMarker('wdio-move-two')
    const six = runScopedMarker('wdio-move-six')
    const markers = [one, two, six]
    await openNewPageTitled(page)
    await typeMarkerVerified(one)
    await enterBlankSibling()
    await typeMarkerVerified(two)
    const sixId = await enterBlankSibling()
    await typeMarkerVerified(six)

    // The editor stays in the moved block across each restructure.
    await browser.keys(['Control', 'Shift', 'ArrowUp'])
    await waitForOutline(markers, [`${one}@1`, `${six}@1`, `${two}@1`], 'move up did not land')
    await waitForEditorIn(sixId, 'the editor left the block move up moved')
    await browser.keys(['Tab'])
    await waitForOutline(markers, [`${one}@1`, `${six}@2`, `${two}@1`], 'Tab did not indent')

    await reopen(page)
    await waitForOutline(
      markers,
      [`${one}@1`, `${six}@2`, `${two}@1`],
      'the re-opened page lost the move up or the indent',
    )

    await editBlock(sixId)
    await browser.keys(['Shift', 'Tab'])
    await waitForOutline(markers, [`${one}@1`, `${six}@1`, `${two}@1`], 'Shift+Tab did not dedent')
    await waitForEditorIn(sixId, 'the editor left the block Shift+Tab moved')
    await browser.keys(['Control', 'Shift', 'ArrowDown'])
    await waitForOutline(markers, [`${one}@1`, `${two}@1`, `${six}@1`], 'move down did not land')

    await reopen(page)
    await waitForOutline(
      markers,
      [`${one}@1`, `${two}@1`, `${six}@1`],
      'the re-opened page lost the dedent or the move down',
    )
  })
})
