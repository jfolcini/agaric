// ---------------------------------------------------------------------------
// Real-backend due date and task state through the agenda (#5365).
//
// `/due` writes `due_date` with `set_due_date`; the Due panel (`list_blocks`
// for the day) and the week view's per-day count (`count_agenda_batch_by_source`)
// both read `agenda_cache`, which the materializer rebuilds in the background.
// The mock keeps no such cache, so only this lane shows a due date that saved
// but never reached the agenda. The second test changes the task's checkbox in
// Edit as Markdown (`apply_page_source`, which the mock does not model for
// task lines) and asserts the block's task state and its Due panel group agree.
//
// The task lives on a page of its own, not on today's journal page: the
// journal's Due panel leaves out the day's own blocks (`excludePageId`).
//
// Two tests in one vault: the second edits the task the first created.
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
  pageSourceLines,
  pageSourceText,
  reopenPageByTitle,
  runScopedMarker,
  setPageSourceLines,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK = runScopedMarker('wdio-due-task')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const DATE_PICKER = '[data-testid="date-picker-popup"]'

let taskId = ''
let today = ''

// A row is `sortable-block` whether it renders static or holds the editor: the
// first test leaves the editor on the task after `/due`, and the re-opened
// page hands it back.
const TASK_ROW = `[data-testid="sortable-block"]*=${TASK}`

/** Leave the page editor and come back, so the task row is the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(TASK_ROW).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The task checkbox's label (`block.taskCycle`: "Task: TODO. Click to cycle."). */
function taskLabel(): Promise<string | null> {
  return $(`[data-block-id="${taskId}"] [data-testid="task-marker"]`).getAttribute('aria-label')
}

/**
 * The Due panel group (`duePanel.group*`) the task is listed under, or null
 * when the panel does not list it. The panel is one virtualized list whose
 * rows are group headers and items in `data-index` order.
 */
function duePanelGroupOfTask(): Promise<string | null> {
  return browser.execute((id: string) => {
    const rows = [
      ...document.querySelectorAll('[data-testid="due-panel"] ul.due-panel-blocks > li'),
    ]
    rows.sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')))
    let group: string | null = null
    for (const row of rows) {
      if (row.classList.contains('due-panel-group-header-row')) {
        group = (row.textContent ?? '').trim()
      } else if (row.id === `block-item-${id}`) {
        return group
      }
    }
    return null
  }, taskId)
}

/**
 * Wait until today's Due panel lists the task under `group`. The agenda rows
 * are written by the background materializer, so a panel that queried before
 * them is re-mounted to query again, as `search-bm25-order` re-submits.
 */
async function waitForDuePanelGroup(group: string): Promise<void> {
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        seen = await duePanelGroupOfTask()
        if (seen === group) return true
        await navigateTo('Pages')
        await navigateTo('Journal')
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 3_000 },
    )
    .catch(() => {
      throw new Error(`today's Due panel lists the task under ${seen}, not ${group}`)
    })
}

/** Switch the journal to `mode` (`JournalControls`, `journalTabId(mode)`). */
async function openJournalMode(mode: 'daily' | 'weekly'): Promise<void> {
  const tab = $(`#journal-tab-${mode}`)
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the ${mode} journal tab never became selected`,
  })
}

describe('Agaric real-backend due date in the agenda (#5365) @journal', () => {
  it('/due today on a TODO lists it in the Due panel and the week count', async () => {
    await waitForAppReady()
    today = await browser.execute(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    // The sidebar click commits the typed task by blurring the editor.
    await openNewPage()
    await typeMarkerVerified(TASK)
    await reopenTheNewPage()
    taskId = (await $(TASK_ROW).getAttribute('data-block-id')) ?? ''
    if (taskId === '') throw new Error('the task block has no data-block-id')

    const checkbox = $(`[data-block-id="${taskId}"] [data-testid="task-marker"]`)
    await checkbox.waitForExist({ timeout: ACTION_TIMEOUT })
    await checkbox.moveTo()
    await checkbox.click()
    await browser.waitUntil(async () => ((await taskLabel()) ?? '').startsWith('Task: TODO.'), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the task checkbox never reported TODO',
    })

    // `/due` opens the date picker (BlockDatePicker); "today" in its text
    // field and Enter pick the date. One key per call: WebKit coalesces
    // identical adjacent keys sent together.
    await $(`[data-testid="block-static"][data-block-id="${taskId}"]`).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['End'])
    await browser.keys([' '])
    for (const ch of '/due') await browser.keys([ch])
    // SuggestionList ids each item `suggestion-<id>` (slash command `due`).
    const dueItem = $('#suggestion-due')
    await dueItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await dueItem.click()
    await typeInputVerified(`${DATE_PICKER} input[aria-label="Type a date"]`, 'today')
    await browser.keys(['Enter'])
    await $(DATE_PICKER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    // The chip renders once `set_due_date` has answered.
    await $(`[data-block-id="${taskId}"] .due-date-chip`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })

    // The durable reads: the journal re-queries the agenda for today.
    await navigateTo('Journal')
    await waitForDuePanelGroup('TODO')

    // The week view mounts after the panel listed the task, so its counts
    // read the same agenda rows (DaySection `journal.agendaCountBadge`).
    await openJournalMode('weekly')
    const day = $(`section[id="journal-${today}"]`)
    await day.waitForExist({ timeout: NAV_TIMEOUT })
    await day.$('button[aria-label="1 Due item, click to view"]').waitForExist({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the week view does not count one due item on ${today}`,
    })
    await openJournalMode('daily')
  })

  it('a checkbox changed in Edit as Markdown sets the task state the Due panel shows', async () => {
    await reopenTheNewPage()
    const source = await openPageSource([TASK])
    const text = await pageSourceText()
    expect(text).toContain(`- [ ] ${TASK}`)
    expect(text).toContain(`due_date:: ${today}`)
    const lines = await pageSourceLines()
    await setPageSourceLines(
      lines.map(({ text: line, id }) => ({
        id,
        text: line.includes(TASK) ? line.replace('- [ ] ', '- [/] ') : line,
      })),
    )
    const save = pageSourceButton('Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    await navigateTo('Journal')
    await waitForDuePanelGroup('DOING')
    await reopenTheNewPage()
    await browser.waitUntil(async () => ((await taskLabel()) ?? '').startsWith('Task: DOING.'), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened task does not read DOING',
    })
  })
})
