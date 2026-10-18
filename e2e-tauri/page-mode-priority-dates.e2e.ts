// ---------------------------------------------------------------------------
// Real-backend: priorities and dates in page mode (#5743).
//
// A page holding a priority or a due or scheduled date used to stay in block
// mode. Now page mode draws block mode's priority badge and date chips under a
// block's text (`src/editor/page-mode/page-tasks.ts`) and changes them through
// `set_priority` and `set_due_date`. This spec gives a task a due date of
// tomorrow through the real IPC, opens the page in page mode, sets a priority
// with Ctrl+Shift+1, cycles it with the badge, and moves the due date to today
// through the chip's date picker. It reads back what the real backend holds:
// the badge and the chip after navigating away and back, and today's Due panel,
// which reads `agenda_cache`, the materializer's view of due dates the mock does
// not keep. `e2e/page-mode.spec.ts` is the per-PR pair against the mock.
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
} from './page-mode'

const TASK = runScopedMarker('wdio-pm-dated')
const NEXT = runScopedMarker('wdio-pm-after')
const DATE_PICKER = '[data-testid="date-picker-popup"]'

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

interface Row {
  priority: string | null
  due_date: string | null
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

/** Wait until what block `blockId` shows under `selector` reads `want` in its aria-label. */
async function waitForLabel(blockId: string, selector: string, want: string, when: string) {
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        const el = inBlock(blockId, selector)
        seen = (await el.isExisting()) ? await el.getAttribute('aria-label') : null
        return seen === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, ${selector} read ${JSON.stringify(seen)}, not ${want}`)
    })
}

/** Wait until the backend holds `want` for block `blockId`. */
async function waitForRow(blockId: string, want: Row, when: string): Promise<void> {
  let seen: Row | null = null
  await browser
    .waitUntil(
      async () => {
        seen = await invoke<Row>('get_block', { blockId })
        return seen.priority === want.priority && seen.due_date === want.due_date
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `${when}, the backend held ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`,
      )
    })
}

/** Click `selector` in block `blockId` through the DOM: layout under it may still move. */
async function clickIn(blockId: string, selector: string): Promise<void> {
  await inBlock(blockId, selector).waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.execute((css: string) => {
    document.querySelector<HTMLElement>(css)?.click()
  }, `${PAGE_MODE} [data-page-block-id="${blockId}"] ${selector}`)
}

describe('Agaric real-backend priorities and dates in page mode (#5743) @editor @pages', () => {
  it('a priority key, the badge and the date picker set them, which stay and reach the Due panel', async () => {
    await waitForAppReady()
    const today = await dayFromToday(0)
    const tomorrow = await dayFromToday(1)
    await openNewPage()
    await typeMarkerVerified(TASK)
    await enterBlankSibling()
    await typeMarkerVerified(NEXT)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    const blockId = (await pageModeBlocks())[await pageModeIndexOf(TASK)]?.id as string

    // A due date set elsewhere keeps nothing out: Page opens with its chip.
    await invoke('set_todo_state', { blockId, state: 'TODO' })
    await invoke('set_due_date', { blockId, date: tomorrow })
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await inBlock(blockId, '.due-date-chip').waitForExist({ timeout: NAV_TIMEOUT })
    expect(await inBlock(blockId, '[data-testid="priority-badge"]').isExisting()).toBe(false)

    // Ctrl+Shift+1 on the block the caret is in.
    await pageModeCaret(await pageModeIndexOf(TASK), 'end')
    await browser.keys(['Control', 'Shift', '1'])
    await waitForLabel(
      blockId,
      '[data-testid="priority-badge"]',
      'Priority P1. Click to cycle.',
      'after Ctrl+Shift+1',
    )
    await waitForRow(blockId, { priority: '1', due_date: tomorrow }, 'after Ctrl+Shift+1')

    // The badge cycles it.
    await clickIn(blockId, '[data-testid="priority-badge"]')
    await waitForLabel(
      blockId,
      '[data-testid="priority-badge"]',
      'Priority P2. Click to cycle.',
      'after the badge’s click',
    )
    await waitForRow(blockId, { priority: '2', due_date: tomorrow }, 'after the badge’s click')

    // The chip opens block mode's date picker: "today" and Enter move the date.
    await clickIn(blockId, '.due-date-chip')
    await typeInputVerified(`${DATE_PICKER} input[aria-label="Type a date"]`, 'today')
    await browser.keys(['Enter'])
    await $(DATE_PICKER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await waitForRow(blockId, { priority: '2', due_date: today }, 'after the date picker')

    // Away and back: the page reopens as *Edit pages as* says, so Page is chosen again.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await waitForLabel(
      blockId,
      '[data-testid="priority-badge"]',
      'Priority P2. Click to cycle.',
      'after navigating away and back',
    )
    await inBlock(blockId, '.due-date-chip').waitForExist({ timeout: NAV_TIMEOUT })
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([TASK, NEXT])

    // Today's Due panel reads `agenda_cache`, which the materializer fills in
    // the background: a panel that queried before it is mounted again.
    await browser
      .waitUntil(
        async () => {
          await navigateTo('Journal')
          const listed = await $(`[data-testid="due-panel"] li#block-item-${blockId}`)
            .waitForExist({ timeout: 3_000 })
            .catch(() => false)
          if (listed) return true
          await navigateTo('Pages')
          return false
        },
        { timeout: NAV_TIMEOUT, interval: 1_000 },
      )
      .catch(() => {
        throw new Error(`today's Due panel never listed the task ${TASK}`)
      })
  })
})
