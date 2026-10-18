// ---------------------------------------------------------------------------
// Real-backend: properties and repeating tasks in page mode (#5743).
//
// A page holding a block property, a repeating task's rule among them, used
// to stay in block mode. Now page mode draws block mode's property chips and
// repeat rule under a block's text (`src/editor/page-mode/page-tasks.ts`),
// and turns a `key:: value` line typed into a block into the property once the
// caret leaves it, through block mode's own commit (`commitInlineProperties`).
// This spec gives one block a property and makes the other a weekly task due
// today, through the real IPC, opens the page in page mode, types a
// `status:: done` line and presses ArrowDown, then completes the task with its
// checkbox. The real backend makes the next occurrence in the same transaction
// (`build_recurrence_sibling_in_tx`), which the mock does not model: page mode
// brings it in with the page's reload. The spec reads back what the backend
// holds, after navigating away and back. `e2e/page-mode.spec.ts` is the per-PR
// pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
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

const TASK = runScopedMarker('wdio-pm-weekly')
const NOTE = runScopedMarker('wdio-pm-note')

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

interface Row {
  todo_state: string | null
  due_date: string | null
}

interface PropertyRow {
  key: string
  value_text: string | null
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

function text(value: string) {
  return { value_text: value, value_num: null, value_date: null, value_ref: null, value_bool: null }
}

/** The local date `days` from today, as `YYYY-MM-DD`. */
function dayFromToday(days: number): Promise<string> {
  return browser.execute((offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, days)
}

function inBlock(blockId: string, selector: string) {
  return $(`${PAGE_MODE} [data-page-block-id="${blockId}"] ${selector}`)
}

/** What block `blockId`'s property chips say, in order. */
function chips(blockId: string): Promise<string[]> {
  return browser.execute(
    (css: string) =>
      [...document.querySelectorAll(css)].map((chip) => chip.getAttribute('aria-label') ?? ''),
    `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="property-chip"]`,
  )
}

async function waitForChips(blockId: string, want: string[], when: string): Promise<void> {
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await chips(blockId)
        return JSON.stringify(seen) === JSON.stringify(want)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `${when}, the chips read ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`,
      )
    })
}

/** The block's properties in the backend, the user's: the text of each, by key. */
async function properties(blockId: string): Promise<Record<string, string | null>> {
  const rows = await invoke<PropertyRow[]>('get_properties', { blockId })
  return Object.fromEntries(
    rows
      .filter(
        (row) => !['created_at', 'completed_at', 'repeat-seq', 'repeat-origin'].includes(row.key),
      )
      .map((row) => [row.key, row.value_text]),
  )
}

/** Wait until the task checkbox of `blockId` names `state`. */
async function waitForState(blockId: string, state: string, when: string): Promise<void> {
  const want = `Task: ${state}. Click to cycle.`
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        const box = inBlock(blockId, '[data-testid="task-marker"]')
        seen = (await box.isExisting()) ? await box.getAttribute('aria-label') : null
        return seen === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the checkbox read ${JSON.stringify(seen)}, not ${want}`)
    })
}

/** Click the checkbox of `blockId` through the DOM: layout under it may still move. */
async function clickCheckbox(blockId: string): Promise<void> {
  await browser.execute((css: string) => {
    document.querySelector<HTMLElement>(css)?.click()
  }, `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="task-marker"]`)
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await chooseEditMode('Page')
}

describe('Agaric real-backend properties and repeating tasks in page mode (#5743)', () => {
  it('a typed line sets a property, a repeating task brings in its next occurrence, and both stay', async () => {
    await waitForAppReady()
    const today = await dayFromToday(0)
    const nextWeek = await dayFromToday(7)
    await openNewPage()
    await typeMarkerVerified(NOTE)
    await enterBlankSibling()
    await typeMarkerVerified(TASK)
    await reopenInPageMode()
    const blocks = await pageModeBlocks()
    const taskId = blocks[await pageModeIndexOf(TASK)]?.id as string
    const noteId = blocks[await pageModeIndexOf(NOTE)]?.id as string

    // A property and a repeating task set elsewhere keep nothing out: Page opens with them.
    await invoke('set_property', { blockId: noteId, key: 'assignee', value: text('Ana') })
    await invoke('set_todo_state', { blockId: taskId, state: 'DOING' })
    await invoke('set_due_date', { blockId: taskId, date: today })
    await invoke('set_property', { blockId: taskId, key: 'repeat', value: text('+1w') })
    await reopenInPageMode()
    await waitForChips(noteId, ['Assignee: Ana'], 'on opening')
    await inBlock(taskId, '.repeat-indicator').waitForExist({ timeout: NAV_TIMEOUT })

    // A `status:: done` line typed on a line of its own is the block's once the caret leaves it
    // for the task below.
    const at = await pageModeIndexOf(NOTE)
    await pageModeCaret(at, 'end')
    await browser.keys(['Shift', 'Enter'])
    await typeInPageMode('status:: done', at, `${NOTE}status:: done`)
    // An arrow pressed in the frame the last key is drawn in is taken back by ProseMirror's selection.
    await browser.execute(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await browser.keys(['ArrowDown'])
    await waitForChips(noteId, ['Assignee: Ana', 'Status: done'], 'after leaving the block')
    await browser.waitUntil(async () => (await pageModeBlocks())[at]?.text === NOTE, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the `status:: done` line stayed in the block’s text',
    })
    expect(await properties(noteId)).toEqual({ assignee: 'Ana', status: 'done' })

    // Completing the task: the backend makes the next occurrence, which the reload brings in.
    await waitForState(taskId, 'DOING', 'before the click')
    await clickCheckbox(taskId)
    await waitForState(taskId, 'DONE', 'after the click')
    let shown: string[] = []
    await browser
      .waitUntil(
        async () => {
          shown = (await pageModeBlocks()).map((block) => block.text)
          return shown.length === 3
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the next occurrence never came in: ${JSON.stringify(shown)}`)
      })
    const nextId = (await pageModeBlocks()).find(
      (block) => block.text === TASK && block.id !== taskId,
    )?.id as string
    expect(nextId).toBeTruthy()
    await waitForState(nextId, 'TODO', 'on the next occurrence')
    await inBlock(nextId, '.repeat-indicator').waitForExist({ timeout: NAV_TIMEOUT })

    // Away and back: the page reopens as *Edit pages as* says, so Page is chosen again.
    await reopenInPageMode()
    await waitForChips(noteId, ['Assignee: Ana', 'Status: done'], 'after navigating away and back')
    await waitForState(taskId, 'DONE', 'after navigating away and back')
    await waitForState(nextId, 'TODO', 'after navigating away and back')
    await inBlock(nextId, '.repeat-indicator').waitForExist({ timeout: NAV_TIMEOUT })
    expect((await pageModeBlocks()).map((block) => block.text).toSorted()).toEqual(
      [TASK, TASK, NOTE].toSorted(),
    )
    const next = await invoke<Row>('get_block', { blockId: nextId })
    expect(next).toMatchObject({ todo_state: 'TODO', due_date: nextWeek })
    expect((await invoke<Row>('get_block', { blockId: taskId })).todo_state).toBe('DONE')
  })
})
