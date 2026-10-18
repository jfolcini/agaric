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
// A second case splits off with Enter a line holding a task marker, a `#name`
// and, on the line after it, a `key:: value` (#5834, #5851, 8431489): the new
// block reads them as typed, so the one leave commits all three, and the
// tag's page then lists the block. `e2e/block-line-break.spec.ts` and
// `e2e/typed-metadata-one-leave.spec.ts` are the per-PR pair against the mock.
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
  openNewPage,
  reopenPageHolding,
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

const SPLIT_PAGE = runScopedMarker('wdio-split-typed-page')
const SPLIT_INTRO = runScopedMarker('wdio-split-typed-intro')
const SPLIT_TASK = runScopedMarker('wdio-split-typed-call')
// Letters, digits and `-` only, so the bare `#name` is the whole tag.
const SPLIT_TAG = runScopedMarker('wdio-split-typed-tag')

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

/** Call the real backend as another surface does. */
function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c: string, a: Record<string, unknown>) =>
      (window as unknown as Internals).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>
}

/** The block the roving editor is in, and its text. */
function editorBlock(): Promise<{ id: string | null; text: string }> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel)
    return {
      id: el?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      text: el?.textContent ?? '',
    }
  }, EDITOR)
}

/** Collapse the editor's selection to the start of its paragraph `index`. */
async function caretAtParagraph(index: number): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string, at: number) => {
          // TipTap keeps its editor on the editable element.
          const dom = document.querySelector<
            HTMLElement & {
              editor?: {
                state: {
                  doc: { child: (i: number) => { nodeSize: number } }
                  selection: { from: number; empty: boolean }
                }
                commands: { setTextSelection: (pos: number) => boolean }
              }
            }
          >(sel)
          if (dom?.editor === undefined) return false
          let pos = 1
          for (let i = 0; i < at; i += 1) pos += dom.editor.state.doc.child(i).nodeSize
          dom.editor.commands.setTextSelection(pos)
          const { from, empty } = dom.editor.state.selection
          return empty && from === pos
        },
        EDITOR,
        index,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `the caret never reached paragraph ${index}` },
  )
}

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

describe('Agaric real-backend line break inside a block (#5160 D2) @editor', () => {
  before(waitForAppReady)

  it('keeps a two-line block as one block through a typo fix and a view round-trip', async () => {
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

  it('a task line, a #name and a key:: value line split off with Enter commit on one leave (#5851)', async () => {
    await openNewPage(SPLIT_PAGE)
    await typeMarkerVerified(SPLIT_INTRO)
    const sourceId = (await editorBlock()).id as string
    await browser.keys(['Escape'])
    await blockStaticByMarker(SPLIT_INTRO).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // Stored as Edit as Markdown or an import writes it: the block reads it as loaded text.
    await invoke('edit_block', {
      blockId: sourceId,
      toText: `${SPLIT_INTRO}\n- [ ] ${SPLIT_TASK} #${SPLIT_TAG}\nstatus:: done`,
    })
    await reopenPageHolding(SPLIT_PAGE, SPLIT_TASK)

    // Into the block by its first line, clear of the task line's checkbox.
    const stored = await blockStaticByMarker(SPLIT_INTRO).getElement()
    const { width, height } = await stored.getSize()
    await browser
      .action('pointer')
      .move({ origin: stored, x: Math.round(6 - width / 2), y: Math.round(6 - height / 2) })
      .down()
      .up()
      .perform()
    await browser.waitUntil(async () => (await editorBlock()).id === sourceId, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the editor never opened in the stored block',
    })
    await caretAtParagraph(1)
    await browser.keys(['Enter'])
    let split = await editorBlock()
    await browser
      .waitUntil(
        async () => {
          split = await editorBlock()
          return split.id !== null && split.id !== sourceId && split.text.includes(SPLIT_TASK)
        },
        { timeout: ACTION_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`Enter never moved the task line to a new block: ${JSON.stringify(split)}`)
      })
    const splitId = split.id as string

    // One leave, then away and back: what the rows show is what the backend stored.
    await browser.keys(['Escape'])
    await reopenPageHolding(SPLIT_PAGE, SPLIT_TASK)
    const rows = await blockStaticsByMarker(SPLIT_TASK)
    expect(rows).toHaveLength(1)
    expect(await rows[0]?.getAttribute('data-block-id')).toBe(splitId)
    const row = `[data-testid="sortable-block"][data-block-id="${splitId}"]`
    let task: string | null = null
    await browser
      .waitUntil(
        async () => {
          const marker = $(`${row} [data-testid="task-marker"]`)
          task = (await marker.isExisting()) ? await marker.getAttribute('aria-label') : null
          return task?.startsWith('Task: TODO.') === true
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the split-off block's task checkbox read ${JSON.stringify(task)}`)
      })
    expect(await $(`${row} [data-testid="tag-ref-chip"]`).getText()).toBe(SPLIT_TAG)
    expect(await $(`${row} [data-testid="property-chip"]`).getText()).toContain('done')
    const text = await rows[0]?.getText()
    expect(text).not.toContain('[ ]')
    expect(text).not.toContain('status::')
    expect(await blockStaticByMarker(SPLIT_INTRO).getText()).not.toContain(SPLIT_TASK)

    // The tag's page lists the block, from what the materializer derived from the tag.
    await browser
      .waitUntil(
        async () => {
          await navigateTo('Tags')
          const tag = $(`[data-testid="tag-item-${SPLIT_TAG}"]`)
          if (!(await tag.waitForClickable({ timeout: 3_000 }).catch(() => false))) return false
          await tag.click()
          return $(`[data-testid="tagged-items"] [data-backlink-item="${splitId}"]`)
            .waitForDisplayed({ timeout: 3_000 })
            .catch(() => false)
        },
        { timeout: NAV_TIMEOUT, interval: 1_000 },
      )
      .catch(() => {
        throw new Error(`the page of tag ${SPLIT_TAG} never listed the split-off block`)
      })
  })
})
