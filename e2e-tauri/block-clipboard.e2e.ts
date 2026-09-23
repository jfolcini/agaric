// ---------------------------------------------------------------------------
// Real-backend block copy and paste through the system clipboard (#5140
// Phase 3b).
//
// Copy used to serialise the selection in TS, one block per line, and paste
// split the text on every newline: a two-line code block came back as a row
// per line, and a pasted copy lost its task state. Copy is now the backend's
// render (`get_blocks_source`) and paste its parse (`paste_blocks`), so a TODO
// parent keeps its state and its child, and a code block stays ONE block. The
// chords run both clipboard plugin calls, `write_text` and `read_text`, the
// latter granted by the capability file for the first time here. The
// Playwright twin (`e2e/block-paste-outline.spec.ts`) runs against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  ctrlClick,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const PARENT = runScopedMarker('wdio-clip-parent')
const CHILD = runScopedMarker('wdio-clip-kid')
const FIRST = runScopedMarker('wdio-clip-codeone')
const SECOND = runScopedMarker('wdio-clip-codetwo')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

interface RowShape {
  marker: string | null
  level: string | null
  task: string | null
  code: boolean
  both: boolean
}

/**
 * Every block row in document order, as the marker it holds, its outline
 * level, its task label and whether it renders a code block with both lines.
 * Rows are `sortable-block`, which a block keeps whether it renders static or
 * holds the editor; a code block is a `pre` either way.
 */
function rowShapes(): Promise<RowShape[]> {
  return browser.execute(
    (markers: string[], first: string, second: string) =>
      Array.from(document.querySelectorAll('[data-testid="sortable-block"]')).map((row) => {
        const item = row.closest('li[aria-level]')
        const text = row.textContent ?? ''
        return {
          marker: markers.find((m) => text.includes(m)) ?? null,
          level: item?.getAttribute('aria-level') ?? null,
          task:
            item?.querySelector('[data-testid="task-marker"]')?.getAttribute('aria-label') ?? null,
          code: row.querySelector('pre') !== null,
          both: text.includes(first) && text.includes(second),
        }
      }),
    [PARENT, CHILD, FIRST],
    FIRST,
    SECOND,
  )
}

/**
 * Wait until the editor sits in an EMPTY block at outline `level`: Enter has
 * moved it to the new sibling, and an indent or dedent has landed.
 */
async function waitForEmptyEditorAt(level: string, what: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser
        .execute(() => {
          const editor = document.querySelector('[data-testid="block-editor"]')
          if (editor?.querySelector('p.is-editor-empty') == null) return null
          return editor.closest('li[aria-level]')?.getAttribute('aria-level') ?? null
        })
        .then((seen) => seen === level),
    { timeout: ACTION_TIMEOUT, timeoutMsg: what },
  )
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${PARENT}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Text the clipboard plugin holds, read the way the paste chord reads it. */
async function clipboardText(): Promise<string> {
  return await browser.execute(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string | null> }
      }
    ).__TAURI_INTERNALS__
    return (await internals.invoke('plugin:clipboard-manager|read_text')) ?? ''
  })
}

describe('Agaric real-backend block clipboard (#5140 Phase 3b)', () => {
  it('copies and pastes a TODO parent with its child and a code block, durably', async () => {
    await waitForAppReady()
    await openNewPage()

    // PARENT, then CHILD indented under it, then a code block back at the
    // top level. Enter moves the editor to a new sibling below.
    await typeMarkerVerified(PARENT)
    await browser.keys(['Enter'])
    await waitForEmptyEditorAt('1', 'Enter did not open a sibling after the parent')
    await browser.keys(['Control', 'Shift', 'ArrowRight'])
    await waitForEmptyEditorAt('2', 'the new block never indented under the parent')
    await typeMarkerVerified(CHILD)
    await browser.keys(['Enter'])
    await waitForEmptyEditorAt('2', 'Enter did not open a sibling after the child')
    await browser.keys(['Control', 'Shift', 'ArrowLeft'])
    await waitForEmptyEditorAt('1', 'the new block never dedented to the top level')
    await browser.keys('/code'.split(''))
    const codeItem = $('[data-testid="suggestion-item"]*=Insert code block')
    await codeItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await codeItem.click()
    await $('[data-testid="block-editor"] pre').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // Inside a code block Enter is a newline; the second line is paced like
    // `typeVerified`'s retry, since its read-back covers only a whole editor.
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

    // The sidebar click blurs and commits the code block.
    await reopenTheNewPage()

    // PARENT becomes a TODO through its task checkbox.
    const parentId = await $(`[data-testid="sortable-block"]*=${PARENT}`).getAttribute(
      'data-block-id',
    )
    const taskMarker = $(`li[data-block-id="${parentId}"]`).$('[data-testid="task-marker"]')
    await taskMarker.moveTo()
    await taskMarker.click()
    await browser.waitUntil(
      // `Set as TODO` until a state is stored, then `Task: TODO. Click to cycle.`
      async () => ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith('Task: TODO'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the parent never became a TODO' },
    )

    // Block-select mode: the chords stand down while a block holds the editor.
    if (await $('[data-testid="block-editor"]').isExisting()) {
      await browser.keys(['Escape'])
      await $('[data-testid="block-editor"]').waitForExist({
        reverse: true,
        timeout: ACTION_TIMEOUT,
      })
    }
    await ctrlClick(blockStaticByMarker(PARENT))
    await ctrlClick(blockStaticByMarker(SECOND))
    await browser.waitUntil(
      async () => (await $('[data-testid="batch-toolbar"]').getText()).includes('2'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+click did not select the two roots' },
    )

    await browser.keys(['Control', 'c'])
    await browser.waitUntil(
      async () => {
        const text = await clipboardText()
        return text.includes(CHILD) && text.includes(SECOND)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+C never put the two roots on the clipboard' },
    )

    // Paste anchors on the last selected root, the code block.
    await browser.keys(['Control', 'v'])
    await browser.waitUntil(
      async () =>
        (await $$(`[data-testid="sortable-block"]*=${PARENT}`).getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+V did not paste a copy of the parent' },
    )
    const toasts = await $$('[data-sonner-toast]').getElements()
    for (const toast of toasts) {
      expect(await toast.getText()).not.toContain('Failed to paste blocks')
    }

    // The durable read: the backend's rows after a round-trip. The original
    // pair, then the pasted copy right after the code block it was anchored
    // on: two TODO parents, each with its child nested under it, and two code
    // blocks each holding both lines — no row per line beside them.
    await reopenTheNewPage()
    await browser.waitUntil(async () => (await rowShapes()).length === 6, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the original and the pasted copy',
    })
    const rows = await rowShapes()
    expect(rows.map((r) => [r.marker, r.level])).toEqual([
      [PARENT, '1'],
      [CHILD, '2'],
      [FIRST, '1'],
      [PARENT, '1'],
      [CHILD, '2'],
      [FIRST, '1'],
    ])
    for (const row of rows.filter((r) => r.marker === PARENT)) {
      expect(row.task).toContain('Task: TODO')
    }
    for (const row of rows.filter((r) => r.marker === FIRST)) {
      expect(row.code).toBe(true)
      expect(row.both).toBe(true)
    }
  })
})
