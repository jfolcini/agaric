// ---------------------------------------------------------------------------
// Real-backend: the block menu in page mode (#5972).
//
// A right click on a block in page mode opens block mode's menu on it
// (`src/editor/page-mode/PageBlockMenu.tsx`). Its structural rows edit the
// document and the save writes the result through the block commands; its
// other rows run block mode's commands after the save. This spec runs one of
// each against the real backend and reads back what it stored: Indent (a
// parent, through `move_block`), Delete with the blocks under the block and
// Ctrl+Z (the same ids back through `restore_block`), Duplicate (new blocks),
// and Cycle task state, which the Agenda lists from the task column the
// materializer keeps. `e2e/page-mode-block-menu.spec.ts` is the per-PR pair
// against the mock.
//
// The right click is the page's own `contextmenu` event (`openContextMenu`):
// a WebDriver right-click is released as a left click.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  invoke,
  navigateTo,
  openContextMenu,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import { PAGE_MODE, chooseEditMode, pageModeBlocks, pageModeCaret } from './page-mode'

const FIRST = runScopedMarker('wdio-pm-menu-first')
const SECOND = runScopedMarker('wdio-pm-menu-second')
const THIRD = runScopedMarker('wdio-pm-menu-third')
const MENU = '[role="menu"][aria-label="Block actions"]'

const text = (id: string) => $(`${PAGE_MODE} [data-page-block-id="${id}"] .page-block-content p`)

/** Right-click block `id`, and wait for its menu. */
async function openBlockMenu(id: string): Promise<void> {
  await openContextMenu(text(id))
  await $(MENU).waitForDisplayed({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `a right click on block ${id} never opened the block menu`,
  })
}

/** Choose a row (its label may be followed by a shortcut hint); the menu closes once its action ran. */
async function choose(label: string, arrange = false): Promise<void> {
  if (arrange) await $(MENU).$('[role="menuitem"]*=Move & arrange').click()
  const row = $(MENU).$(`[role="menuitem"]*=${label}`)
  await row.waitForClickable({ timeout: ACTION_TIMEOUT })
  await row.click()
  await $(MENU).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/** Wait for the backend to hold block `id` live (`live`) or not: `get_block` is refused for a deleted one. */
async function waitForBlock(id: string, live: boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await invoke('get_block', { blockId: id }).then(
        () => true,
        () => false,
      )
      return found === live
    },
    { timeout: NAV_TIMEOUT, timeoutMsg },
  )
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await chooseEditMode('Page')
}

/** The ids of the page-mode blocks whose text holds each marker, in the order given. */
async function idsOf(...markers: string[]): Promise<string[]> {
  const blocks = await pageModeBlocks()
  return markers.map((marker) => {
    const found = blocks.find((block) => block.text.includes(marker))
    if (found === undefined) throw new Error(`no page-mode block holds ${marker}`)
    return found.id
  })
}

describe('Agaric real-backend block menu in page mode (#5972) @editor @pages', () => {
  before(waitForAppReady)

  it('Indent, Delete with Ctrl+Z, Duplicate and Cycle task state act on the block under the pointer, and stay', async () => {
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await enterBlankSibling()
    await typeMarkerVerified(SECOND)
    await enterBlankSibling()
    await typeMarkerVerified(THIRD)
    await reopenInPageMode()
    const [first, second, third] = await idsOf(FIRST, SECOND, THIRD)
    // The caret rests in the first block: every row below is for another block.
    await pageModeCaret(0, 'end')

    await openBlockMenu(second as string)
    await choose('Indent', true)
    await browser.waitUntil(async () => (await pageModeBlocks())[1]?.depth === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Indent never moved the second block under the first',
    })
    await reopenInPageMode()
    expect((await pageModeBlocks()).map((block) => block.depth)).toEqual([0, 1, 0])
    expect((await invoke<{ parent_id: string }>('get_block', { blockId: second })).parent_id).toBe(
      first,
    )

    // Delete takes the block and the one under it; Ctrl+Z brings both back, by id.
    await openBlockMenu(first as string)
    await choose('Delete')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Delete never removed the first block and the block under it',
    })
    await waitForBlock(first as string, false, 'the backend never deleted the first block')
    await browser.keys(['Control', 'z'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 3, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Ctrl+Z never brought the deleted blocks back',
    })
    await waitForBlock(second as string, true, 'the backend never restored the second block')
    expect((await pageModeBlocks()).map((block) => block.id)).toEqual([first, second, third])

    await openBlockMenu(third as string)
    await choose('Duplicate', true)
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 4, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Duplicate never added a block',
    })
    await openBlockMenu(third as string)
    await choose('Set as TODO')
    await browser.waitUntil(
      async () =>
        (await invoke<{ todo_state: string | null }>('get_block', { blockId: third }))
          .todo_state === 'TODO',
      { timeout: NAV_TIMEOUT, timeoutMsg: 'Cycle task state never set the third block’s task' },
    )

    // Away and back: the page as the backend stored it.
    await reopenInPageMode()
    const after = await pageModeBlocks()
    expect(after.map((block) => [block.depth, block.text.trim()])).toEqual([
      [0, FIRST],
      [1, SECOND],
      [0, THIRD],
      [0, THIRD],
    ])
    expect(after[0]?.id).toBe(first)
    expect(after[3]?.id).not.toBe(third)
    expect(
      (await invoke<{ todo_state: string | null }>('get_block', { blockId: third })).todo_state,
    ).toBe('TODO')
    expect(
      (await invoke<{ todo_state: string | null }>('get_block', { blockId: after[3]?.id }))
        .todo_state,
    ).toBeNull()
  })
})
