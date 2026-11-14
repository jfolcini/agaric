// ---------------------------------------------------------------------------
// Real-backend week view: a day's due count follows a date set in that view
// (#6567).
//
// `/due` writes `due_date` with `set_due_date`. The week view's per-day count
// (`count_agenda_batch_by_source`) reads `agenda_cache`, which the materializer
// rebuilds whole, in the background, after the command has answered, and the
// view reads again a debounce after the write. When the rebuild outlasts that
// debounce the view read the old rows and kept them: in a debug build the
// rebuild takes about 35 ms per thousand dated blocks, so from some 4,500.
//
// Seeding that many through commands takes minutes, so this spec's app starts
// every background batch a second late instead (`SPECS_WITH_A_SLOW_MATERIALIZER`,
// wdio.conf.ts). The spec never leaves the week view between the write and the
// count: a view mounted afterwards reads a cache that is rebuilt by then, which
// is how `due-date-agenda.e2e.ts` reads it. The mock keeps no such cache.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK = runScopedMarker('wdio-due-count')

const DATE_PICKER = '[data-testid="date-picker-popup"]'

let today = ''
const todaySection = () => `section[id="journal-${today}"]`

/** Open the journal's week view (`JournalControls`, `journalTabId('weekly')`). */
async function openWeekView(): Promise<void> {
  await navigateTo('Journal')
  const tab = $('#journal-tab-weekly')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: 'the Weekly view tab never became selected',
  })
  // A week day mounts its blocks once it is on screen.
  await $(todaySection()).waitForExist({ timeout: NAV_TIMEOUT })
  await browser.execute(
    (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
    todaySection(),
  )
}

/** In today's section of the week view: a new block holding `marker`, due today by `/due`. */
async function addTaskDueToday(marker: string): Promise<void> {
  const day = todaySection()
  const addBlock = $(day).$('.//button[contains(normalize-space(.), "Add block")]')
  await addBlock.waitForClickable({ timeout: ACTION_TIMEOUT })
  await addBlock.click()
  const editor = `${day} [data-testid="block-editor"] [contenteditable="true"]`
  await $(editor).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.waitUntil(
    () => browser.execute((sel) => document.activeElement === document.querySelector(sel), editor),
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'the new block editor never took focus' },
  )
  await typeMarkerVerified(marker)
  // One key per call: WebKit coalesces identical adjacent keys sent together.
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
  await $(day)
    .$(`[data-testid="sortable-block"]*=${marker}`)
    .$('.due-date-chip')
    .waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/** Today's section shows `label` on its due count (`journal.agendaCountBadge`). */
async function expectDueCount(label: string): Promise<void> {
  await $(todaySection())
    .$(`button[aria-label="${label}, click to view"]`)
    .waitForExist({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the week view, never left since the date was set, does not show "${label}" on ${today}`,
    })
}

describe('Agaric real-backend week view due count after a date write (#6567) @journal', () => {
  it('counts a task made due today in the week view, without leaving the view', async () => {
    await waitForAppReady()
    today = await browser.execute(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await openWeekView()
    await addTaskDueToday(TASK)
    await expectDueCount('1 Due item')
  })
})
