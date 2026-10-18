// ---------------------------------------------------------------------------
// Real-backend: tasks in page mode (#5743).
//
// A page holding a task used to stay in block mode. Now page mode draws block
// mode's checkbox beside a task's text (`src/editor/page-mode/page-tasks.ts`),
// cycles it through `set_todo_state`, and turns a task marker left as text into
// the block's state through block mode's own commit (`commitCheckboxState`).
// This spec types `[ ] ` at the start of a block in page mode, presses
// ArrowDown, clicks the checkbox, and reads back what the real backend holds:
// the checkbox after navigating away and back, and the Agenda's task list,
// which reads the block's `todo_state` column. A second case adds a block in
// page mode and runs `/todo` and `/due` on it from the slash menu (#5866):
// page mode runs those after the save that creates the block, an order the
// mock does not keep. `e2e/page-mode.spec.ts` is the per-PR pair against the
// mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  isoDay,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const MARKER = runScopedMarker('wdio-pm-task')
const NEXT = runScopedMarker('wdio-pm-after')
const SLASH_PAGE = runScopedMarker('wdio-pm-slash-page')
const SLASH_FIRST = runScopedMarker('wdio-pm-slash-first')
const SLASH_TASK = runScopedMarker('wdio-pm-slash-task')
const MENU = '[data-testid="suggestion-popup"]'
const DATE_PICKER = '[data-testid="date-picker-popup"]'

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

/** The checkbox of the page-mode block whose id is `blockId`. */
function checkbox(blockId: string) {
  return $(`${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="task-marker"]`)
}

async function waitForState(blockId: string, state: string, when: string): Promise<void> {
  const want = `Task: ${state}. Click to cycle.`
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        const box = checkbox(blockId)
        seen = (await box.isExisting()) ? await box.getAttribute('aria-label') : null
        return seen === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the block's checkbox read ${JSON.stringify(seen)}, not ${want}`)
    })
}

/** Open the Journal's Agenda view and wait for its task list to hold `marker`. */
async function waitForAgendaToList(marker: string): Promise<void> {
  await navigateTo('Journal')
  const agenda = $('button[role="tab"][aria-label="Agenda view"]')
  await agenda.waitForClickable({ timeout: NAV_TIMEOUT })
  await agenda.click()
  await browser.waitUntil(
    async () => {
      for (const row of await $$('[data-testid="agenda-results-item"]').getElements()) {
        if ((await row.getText()).includes(marker)) return true
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `the Agenda never listed the task ${marker}` },
  )
}

/** Wait for the open slash menu to highlight `id`, then pick it with Enter. */
async function pickFromSlashMenu(id: string): Promise<void> {
  // A pointer resting where the menu opens would move its highlight.
  await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
  await $(`${MENU} #suggestion-${id}[aria-selected="true"]`).waitForExist({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the slash menu never highlighted ${id}`,
  })
  await browser.keys(['Enter'])
  await $(MENU).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend tasks in page mode (#5743) @editor @pages', () => {
  before(waitForAppReady)

  it('a typed marker and a click set the task, which stays and reaches the Agenda', async () => {
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await enterBlankSibling()
    await typeMarkerVerified(NEXT)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    const at = await pageModeIndexOf(MARKER)
    const blockId = (await pageModeBlocks())[at]?.id as string
    await pageModeCaret(at, 0)
    await typeInPageMode('[ ] ', at, `[ ] ${MARKER}`)
    // Nothing yet: the caret is still in the block.
    expect(await checkbox(blockId).isExisting()).toBe(false)
    // An arrow pressed in the frame the last key is drawn in is taken back by ProseMirror's selection.
    await browser.execute(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await browser.keys(['ArrowDown'])
    await waitForState(blockId, 'TODO', 'after ArrowDown')
    await browser.waitUntil(async () => (await pageModeBlocks())[at]?.text === MARKER, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the marker stayed in the block’s text',
    })

    // The checkbox's own click: the DOM's, as layout under it may still move.
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)?.click()
    }, `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="task-marker"]`)
    await waitForState(blockId, 'DOING', 'after a click')

    // Away and back: the state is read from what the backend stored. The page
    // reopens as *Edit pages as* says (Blocks); the switch is the page on
    // screen's only. Page opens again: the `created_at` the task's state wrote
    // keeps nothing out.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await waitForState(blockId, 'DOING', 'after navigating away and back')
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([MARKER, NEXT])

    // The Agenda lists open tasks (TODO and DOING) from the backend's task column.
    await waitForAgendaToList(MARKER)
  })

  it('/todo and /due from the slash menu set the task and the date of a block added in page mode (#5866)', async () => {
    const today = isoDay(new Date())
    await openNewPage(SLASH_PAGE)
    await typeMarkerVerified(SLASH_FIRST)
    await navigateTo('Journal')
    await reopenPageByTitle(SLASH_PAGE)
    await chooseEditMode('Page')

    // A block added in page mode exists only in the document until a save creates it.
    await pageModeCaret(await pageModeIndexOf(SLASH_FIRST), 'end')
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Enter never added a block to the page-mode document',
    })
    await typeInPageMode(`${SLASH_TASK} /todo`, 1, `${SLASH_TASK} /todo`)
    await pickFromSlashMenu('todo')
    const blockId = (await pageModeBlocks())[1]?.id as string
    await waitForState(blockId, 'TODO', 'after /todo')

    // /due opens block mode's date picker on the caret's block.
    await typeInPageMode('/due', 1, `${SLASH_TASK} /due`)
    await pickFromSlashMenu('due')
    await typeInputVerified(`${DATE_PICKER} input[aria-label="Type a date"]`, 'today')
    await browser.keys(['Enter'])
    await $(DATE_PICKER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    const chip = $(`${PAGE_MODE} [data-page-block-id="${blockId}"] .due-date-chip`)
    await chip.waitForExist({ timeout: ACTION_TIMEOUT })

    // Away and back: the checkbox and the chip are drawn from what the backend stored.
    await browser.keys(['Escape'])
    await navigateTo('Journal')
    await reopenPageByTitle(SLASH_PAGE)
    await chooseEditMode('Page')
    await waitForState(blockId, 'TODO', 'after navigating away and back')
    await chip.waitForExist({ timeout: NAV_TIMEOUT })
    expect((await pageModeBlocks()).map((block) => block.text.trim())).toEqual([
      SLASH_FIRST,
      SLASH_TASK,
    ])
    const row = await invoke<{ todo_state: string | null; due_date: string | null }>('get_block', {
      blockId,
    })
    expect(row).toMatchObject({ todo_state: 'TODO', due_date: today })

    await waitForAgendaToList(SLASH_TASK)
  })
})
