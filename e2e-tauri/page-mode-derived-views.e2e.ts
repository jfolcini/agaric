// ---------------------------------------------------------------------------
// Real-backend: what the backend derives from a page-mode save (#6714).
//
// Page mode writes through its own planner (`src/editor/page-mode/page-save.ts`)
// and the mock derives nothing in the background, so only this lane shows a
// page-mode edit that never reached a view the materializer keeps:
//
// - the search index (`fts_blocks`): the word typed is found, the word it
//   replaced is not;
// - the link graph: a `[[link]]` typed lists its block under the linked page;
// - the op log's reverse path: the page's undo takes a page-mode edit back and
//   redo puts it back (undo is waived from conformance, see `undo-todo-state`);
// - `paste_blocks` and the Rust grammar: list lines naming a new page land as
//   blocks linking it, and the page exists. (Two plain lines are one
//   paragraph to that grammar, so they land as one block.)
//
// Block mode's twins: `search-edited-word`, `table-cell-link-backlink`,
// `undo-todo-state`, `paste-splice`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  invoke,
  navigateTo,
  openNewPage,
  pagesTitled,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForPickerToOffer,
  waitForResults,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

// Plain words with no letter doubled (see `runScopedMarker`), in no marker.
const OLD = 'granite'
const NEW = 'cobalt'
const PAGE = runScopedMarker('wdio-pm-derived-page')
const TARGET = runScopedMarker('wdio-pm-derived-target')
const PASTED = runScopedMarker('wdio-pm-derived-pasted')
const EDITED = runScopedMarker('wdio-pm-derived-edited')
const KEPT = runScopedMarker('wdio-pm-derived-kept')
const LINKING = runScopedMarker('wdio-pm-derived-linking')
const UNDONE = runScopedMarker('wdio-pm-derived-undone')

const stored = async (id: string): Promise<string> =>
  (await invoke<{ content: string }>('get_block', { blockId: id })).content

/** Wait for the backend to hold `text` as block `id`'s. */
async function waitForStored(id: string, text: string | RegExp, what: string): Promise<string> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await stored(id)
        return typeof text === 'string' ? seen === text : text.test(seen)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}; the backend holds ${JSON.stringify(seen)}`)
    })
  return seen
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(PAGE)
  await chooseEditMode('Page')
}

/** The index and id of the page-mode block holding `marker`. */
async function blockHolding(marker: string): Promise<{ at: number; id: string }> {
  const at = await pageModeIndexOf(marker)
  return { at, id: (await pageModeBlocks())[at]?.id as string }
}

describe('Agaric real-backend page mode: search, backlinks, the page’s undo and a paste (#6714) @editor @pages @search', () => {
  before(async () => {
    await waitForAppReady()
    await openNewPage(TARGET)
    await openNewPage(PAGE)
    await typeMarkerVerified(`${KEPT} ${OLD}`)
    await enterBlankSibling()
    await typeMarkerVerified(`${EDITED} ${OLD}`)
    await enterBlankSibling()
    await typeMarkerVerified(LINKING)
    await enterBlankSibling()
    await typeMarkerVerified(UNDONE)
  })

  it('a word typed in page mode is found by search, and the word it replaced is not', async () => {
    await reopenInPageMode()
    const kept = await blockHolding(KEPT)
    const edited = await blockHolding(EDITED)
    // The Search view then holds an answer listing the block for the old word.
    await navigateTo('Search')
    await waitForResults(
      OLD,
      (ids) => ids.includes(kept.id) && ids.includes(edited.id),
      'the old word never found both blocks before the edit',
    )

    await reopenInPageMode()
    await pageModeCaret(edited.at, 'end')
    // One key a call: WebKitGTK's driver can drop a key pressed again while held.
    for (let i = 0; i < OLD.length; i += 1) await browser.keys(['Backspace'])
    await browser.waitUntil(
      async () => (await pageModeBlocks())[edited.at]?.text.trim() === EDITED,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Backspace never removed the old word' },
    )
    await typeInPageMode(NEW, edited.at, `${EDITED} ${NEW}`)
    await waitForStored(edited.id, `${EDITED} ${NEW}`, 'page mode never saved the new word')

    await navigateTo('Search')
    await waitForResults(
      NEW,
      (ids) => ids.includes(edited.id),
      'the new word never found the block edited in page mode',
    )
    await waitForResults(
      OLD,
      (ids) => ids.includes(kept.id) && !ids.includes(edited.id),
      'the old word still finds the block edited in page mode',
    )
  })

  it('a [[link]] typed in page mode lists its block under the linked page', async () => {
    await reopenInPageMode()
    const linking = await blockHolding(LINKING)
    await pageModeCaret(linking.at, 'end')
    await typeInPageMode(` [[${TARGET}`, linking.at, `${LINKING} [[${TARGET}`)
    await waitForPickerToOffer(TARGET)
    // One `]` a call: WebKit coalesces two identical keys sent together.
    await typeInPageMode(']', linking.at, `${LINKING} [[${TARGET}]`)
    await browser.keys([']'])
    // The chip, not the block's text: beside the caret a chip shows its `[[…]]` source.
    await $(
      `${PAGE_MODE} [data-page-block-id="${linking.id}"] [data-testid="block-link-chip"]`,
    ).waitForExist({ timeout: ACTION_TIMEOUT, timeoutMsg: 'the typed link never became a chip' })
    await waitForStored(
      linking.id,
      new RegExp(`^${LINKING} \\[\\[[0-9A-Z]{26}\\]\\]$`),
      'page mode never saved the link by the page’s id',
    )

    await reopenPageByTitle(TARGET)
    await $(`[data-backlink-item="${linking.id}"]`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the linked page never listed the block the link was typed in',
    })
  })

  it('the page’s undo takes a page-mode edit back and redo puts it back, and it stays', async () => {
    await reopenInPageMode()
    const undone = await blockHolding(UNDONE)
    await pageModeCaret(undone.at, 'end')
    await typeInPageMode(` ${NEW}`, undone.at, `${UNDONE} ${NEW}`)
    await waitForStored(undone.id, `${UNDONE} ${NEW}`, 'page mode never saved the edit')

    // Out of the text: Ctrl+Z inside it is the editor's own undo.
    await browser.keys(['Escape'])
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
    await browser.keys(['Control', 'z'])
    await waitForStored(undone.id, UNDONE, 'the page’s undo never took the edit back')
    await browser.waitUntil(async () => (await pageModeBlocks())[undone.at]?.text === UNDONE, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the open document never showed the undone text',
    })

    await browser.keys(['Control', 'y'])
    await waitForStored(undone.id, `${UNDONE} ${NEW}`, 'the page’s redo never put the edit back')
    await browser.waitUntil(
      async () => (await pageModeBlocks())[undone.at]?.text === `${UNDONE} ${NEW}`,
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the open document never showed the redone text' },
    )

    await reopenInPageMode()
    expect((await pageModeBlocks())[undone.at]?.text).toBe(`${UNDONE} ${NEW}`)
    expect((await pageModeBlocks())[undone.at]?.id).toBe(undone.id)
  })

  it('list lines naming a new page, pasted in page mode, land as blocks linking it, and the page exists', async () => {
    await reopenInPageMode()
    const before = await pageModeBlocks()
    await pageModeCaret(before.length - 1, 'end')
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === before.length + 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Enter never added a block to paste into',
    })

    await browser.execute(
      (selector: string, text: string) => {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        document
          .querySelector(selector)
          ?.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          )
      },
      PAGE_MODE,
      `- first [[${PASTED}]]\n- second line`,
    )

    let landed: string[] = []
    await browser
      .waitUntil(
        async () => {
          landed = (await pageModeBlocks()).slice(before.length).map((block) => block.text)
          return landed.join('|') === `first ${PASTED}|second line`
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the pasted lines landed as ${JSON.stringify(landed)}`)
      })
    const [first] = (await pageModeBlocks()).slice(before.length)
    await waitForStored(
      first?.id as string,
      /^first \[\[[0-9A-Z]{26}\]\]$/,
      'the pasted link was never stored by the new page’s id',
    )
    expect(await pagesTitled(PASTED)).toBe(1)

    await reopenInPageMode()
    expect((await pageModeBlocks()).slice(before.length).map((block) => block.text)).toEqual([
      `first ${PASTED}`,
      'second line',
    ])
  })
})
