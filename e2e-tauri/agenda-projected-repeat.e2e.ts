// ---------------------------------------------------------------------------
// Real-backend repeating tasks: projection, anchoring modes and the drawer
// (#5366, #5734, #5735, #5736).
//
// A TODO due today that repeats every week occurs again a week out, and the
// Due panel of that day lists it as a `projected-entry` (DuePanel.tsx) from
// `list_projected_agenda`: the `projected_agenda_cache` the materializer
// rebuilds, or the on-the-fly projector when that cache does not cover the
// day. The projection stops at `repeat-until` and after `repeat-count`
// occurrences. Agenda mode lists the same projection over the coming week
// (`useAgendaProjectedEntries`). The mock answers the command with an empty
// page (`e2e/journal-panels.spec.ts`), so only this lane shows the projection.
//
// Completing a repeating task makes its next occurrence in the same
// transaction (`build_recurrence_sibling_in_tx`): `.+` counts the interval
// from today, `++` steps the stale date forward until it passes today, and
// the rule and its bounds edited in the block's property drawer are the ones
// that completion reads. The mock models none of that recurrence.
//
// Each task lives on a page of its own: the journal's Due panel leaves out
// the day's own blocks (`excludePageId`). Checkboxes, dates and rules are
// seeded in one Edit as Markdown save, the way `block-duplicate-repeat` sets
// its rule. The tests share one vault, so each writes its own titled page.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  cycleTaskTo,
  distinctKeyChunks,
  editAtEnd,
  navigateTo,
  occurrenceIn,
  openContextMenu,
  openNewPage,
  openPageSource,
  pageSourceButton,
  pageSourceLines,
  pickRepeatCommand,
  reopenPageHolding,
  runScopedMarker,
  type SourceLine,
  setPageSourceLines,
  taskRows,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK = runScopedMarker('wdio-projected')
const TASK_PAGE = runScopedMarker('wdio-projected-page')

/** Local calendar days `from` to `from + count - 1` from today, as `YYYY-MM-DD`. */
async function localDays(from: number, count: number): Promise<string[]> {
  return browser.execute(
    (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const d = new Date()
        d.setDate(d.getDate() + start + i)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }),
    from,
    count,
  )
}

/** A local calendar day `offset` days from today. */
async function localDay(offset: number): Promise<string> {
  const [day] = await localDays(offset, 1)
  if (day === undefined) throw new Error(`no date ${offset} days from today`)
  return day
}

interface SeededTask {
  task: string
  /** Its property lines, `key:: value`. */
  props: string[]
}

/**
 * Create page `title` holding each of `tasks` as an open TODO with its
 * property lines, written in one Edit as Markdown save, and return each
 * task's block id.
 */
async function seedTasks(title: string, tasks: SeededTask[]): Promise<string[]> {
  const [first] = tasks
  if (first === undefined) throw new Error('no task to seed')
  // The sidebar click in `reopenPageHolding` commits the typed task by blurring the editor.
  await openNewPage(title)
  await typeMarkerVerified(first.task)
  await reopenPageHolding(title, first.task)

  const source = await openPageSource([first.task])
  const firstId = (await pageSourceLines()).find(({ text }) => text.includes(first.task))?.id
  if (firstId === undefined) throw new Error(`the source holds no line for ${first.task}`)
  const lines: SourceLine[] = []
  for (const [i, { task, props }] of tasks.entries()) {
    lines.push({ text: `- [ ] ${task}`, id: i === 0 ? firstId : null })
    for (const prop of props) lines.push({ text: `  ${prop}`, id: null })
  }
  lines.push({ text: '', id: null })
  await setPageSourceLines(lines)
  const save = pageSourceButton('Save')
  await save.waitForClickable({ timeout: ACTION_TIMEOUT })
  await save.click()
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })

  await reopenPageHolding(title, first.task)
  const ids: string[] = []
  for (const { task } of tasks) {
    const row = blockStaticByMarker(task)
    await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await row.getAttribute('data-block-id')
    if (id === null) throw new Error(`the seeded task ${task} has no block id`)
    ids.push(id)
  }
  return ids
}

/** Wait until block `id`'s task checkbox, as the backend re-read it, reports `state`. */
async function waitForTaskState(id: string, state: string): Promise<void> {
  const marker = $(`[data-block-id="${id}"] [data-testid="task-marker"]`)
  await browser.waitUntil(
    async () =>
      (await marker.isExisting()) &&
      ((await marker.getAttribute('aria-label')) ?? '').startsWith(`Task: ${state}.`),
    { timeout: NAV_TIMEOUT, timeoutMsg: `block ${id} never read ${state} after the round-trip` },
  )
}

/** The texts of the projected entries in the Due panel of journal day `day`. */
async function projectedTexts(day: string): Promise<string[]> {
  return browser.execute(
    (sectionId: string) =>
      [
        ...document.querySelectorAll(`section[id="${sectionId}"] [data-testid="projected-entry"]`),
      ].map((entry) => entry.textContent ?? ''),
    `journal-${day}`,
  )
}

/**
 * The projected entries of the open journal day `day` once they hold every one
 * of `expected`. The panel keeps a day's projection for
 * `PROJECTED_CACHE_TTL_MS` (useDuePanelData.ts), so an answer from before the
 * cache rebuild can be served again for that long: the wait outlasts it, and
 * each remount asks again.
 */
async function projectedOnceHolding(day: string, expected: string[]): Promise<string[]> {
  let texts: string[] = []
  await browser.waitUntil(
    async () => {
      texts = await projectedTexts(day)
      if (expected.every((task) => texts.some((text) => text.includes(task)))) return true
      await navigateTo('Pages')
      await navigateTo('Journal')
      await $(`section[id="journal-${day}"]`).waitForExist({ timeout: NAV_TIMEOUT })
      return false
    },
    {
      timeout: 2 * NAV_TIMEOUT,
      interval: 3_000,
      timeoutMsg: `the Due panel of ${day} never projected ${expected.join(', ')}`,
    },
  )
  return texts
}

/** Each projected Agenda row holding `task`: its text and its `<time>` date. */
async function agendaProjectedRows(task: string): Promise<Array<{ text: string; date: string }>> {
  return browser.execute(
    (marker: string) =>
      [...document.querySelectorAll('[data-testid="agenda-view"] [data-testid="projected-entry"]')]
        .filter((row) => (row.textContent ?? '').includes(marker))
        .map((row) => ({
          text: row.textContent ?? '',
          date: row.querySelector('time')?.getAttribute('datetime') ?? '',
        })),
    task,
  )
}

/** Step the Daily journal forward one day to `day`. */
async function nextJournalDay(day: string): Promise<void> {
  const next = $('button[aria-label="Next day"]')
  await next.waitForClickable({ timeout: NAV_TIMEOUT })
  await next.click()
  await $(`section[id="journal-${day}"]`).waitForExist({ timeout: NAV_TIMEOUT })
}

/** Open block `id`'s property drawer from its context menu. */
async function openPropertyDrawer(id: string): Promise<void> {
  await openContextMenu($(`[data-testid="block-static"][data-block-id="${id}"]`))
  const item = $('[role="menuitem"]*=Properties')
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
  await $('[role="dialog"]*=Block Properties').waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/** Close the open property drawer. */
async function closePropertyDrawer(): Promise<void> {
  await browser.keys(['Escape'])
  await $('[role="dialog"]*=Block Properties').waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
  })
}

const drawerInput = (key: string) => $(`input[data-testid="property-value-input-${key}"]`)

/** Replace the drawer's `key` value with `value`; Enter blurs the field, which saves it. */
async function setDrawerField(key: string, value: string): Promise<void> {
  const input = drawerInput(key)
  await input.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await input.click()
  await browser.keys(['Control', 'a'])
  await browser.keys(['Delete'])
  await browser.waitUntil(async () => (await input.getValue()) === '', {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the drawer's ${key} field did not clear`,
  })
  for (const chunk of distinctKeyChunks(value)) await browser.keys(Array.from(chunk))
  await browser.waitUntil(async () => (await input.getValue()) === value, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the drawer's ${key} field never read ${value}`,
  })
  await browser.keys(['Enter'])
}

/** The drawer's value for each of `keys`. */
async function drawerValues(keys: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const key of keys) {
    const input = key === 'due' ? $('input[aria-label="Due value"]') : drawerInput(key)
    await input.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    values[key] = await input.getValue()
  }
  return values
}

describe('Agaric real-backend repeating tasks (#5366, #5734, #5735, #5736) @journal', () => {
  before(waitForAppReady)

  it('lists a weekly TODO due today as projected in the Due panel a week out', async () => {
    // Today and the next seven days, spelled as the journal's day-section ids.
    const days = await localDays(0, 8)
    const [today] = days
    const weekOut = days.at(-1)
    if (today === undefined || weekOut === undefined) throw new Error('no dates to step through')

    // The sidebar click commits the typed task by blurring the editor.
    await openNewPage(TASK_PAGE)
    await typeMarkerVerified(TASK)
    await reopenPageHolding(TASK_PAGE, TASK)

    const source = await openPageSource([TASK])
    const base = await pageSourceLines()
    await setPageSourceLines([
      ...base
        .filter((line) => line.text !== '')
        .map(({ text, id }) => ({ id, text: text.replace(`- ${TASK}`, `- [ ] ${TASK}`) })),
      ...[`  due_date:: ${today}`, '  repeat:: +1w', ''].map((text) => ({ text, id: null })),
    ])
    const save = pageSourceButton('Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })
    await reopenPageHolding(TASK_PAGE, TASK)
    await $(`[data-testid="sortable-block"]*=${TASK}`).$('.repeat-indicator').waitForExist({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the saved task shows no repeat chip',
    })

    // Daily mode (the default) steps one day per "Next day" (JournalControls).
    await navigateTo('Journal')
    for (const day of days.slice(1)) await nextJournalDay(day)

    const projected = () =>
      $(`section[id="journal-${weekOut}"]`).$(`[data-testid="projected-entry"]*=${TASK}`)
    await projectedOnceHolding(weekOut, [TASK])
    await expect(projected()).toBeDisplayed()
  })

  it('stops projecting a daily task after its repeat-until date and its repeat-count', async () => {
    const page = runScopedMarker('wdio-bounds-page')
    const counted = runScopedMarker('wdio-count-three')
    const until = runScopedMarker('wdio-until-two')
    const open = runScopedMarker('wdio-unbounded')
    const days = await localDays(0, 5)
    const [today, , inTwo] = days
    if (today === undefined || inTwo === undefined) throw new Error('no dates to step through')
    const daily = [`due_date:: ${today}`, 'repeat:: daily']
    await seedTasks(page, [
      { task: counted, props: [...daily, 'repeat-count:: 3'] },
      { task: until, props: [...daily, `repeat-until:: ${inTwo}`] },
      { task: open, props: daily },
    ])

    await navigateTo('Journal')
    const goToToday = $('button[aria-label="Go to today"]')
    await goToToday.waitForClickable({ timeout: NAV_TIMEOUT })
    await goToToday.click()
    await $(`section[id="journal-${today}"]`).waitForExist({ timeout: NAV_TIMEOUT })

    // The unbounded task, projected every day, says the day's panel has
    // answered after the save; the first day waits for all three.
    const seen: Record<string, { counted: boolean; until: boolean }> = {}
    for (const [i, day] of days.slice(1).entries()) {
      await nextJournalDay(day)
      const texts = await projectedOnceHolding(day, i === 0 ? [counted, until, open] : [open])
      seen[day] = {
        counted: texts.some((text) => text.includes(counted)),
        until: texts.some((text) => text.includes(until)),
      }
    }
    const [, inOne, , inThree, inFour] = days
    expect(seen).toEqual({
      [inOne ?? '']: { counted: true, until: true },
      [inTwo]: { counted: true, until: true },
      [inThree ?? '']: { counted: true, until: false },
      [inFour ?? '']: { counted: false, until: false },
    })
  })

  it('/repeat .+ counts from today and ++ steps past stale dates, weekly and monthly', async () => {
    const page = runScopedMarker('wdio-anchor-page')
    const dates = await browser.execute(() => {
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const plus = (n: number) => {
        const d = new Date(today)
        d.setDate(d.getDate() + n)
        return iso(d)
      }
      // A month on from today keeps the day, clamped to the month's length.
      const y = today.getFullYear()
      const m = today.getMonth() + 1
      const lastDay = new Date(y, m + 1, 0).getDate()
      const monthOn = iso(new Date(y, m, Math.min(today.getDate(), lastDay)))
      // The 5th never clamps, so stepping it a month at a time stays on the 5th.
      let fifth = new Date(y, today.getMonth() - 2, 5)
      const staleFifth = iso(fifth)
      while (fifth <= today) fifth = new Date(fifth.getFullYear(), fifth.getMonth() + 1, 5)
      return {
        tenAgo: plus(-10),
        fortyAgo: plus(-40),
        inFour: plus(4),
        inSeven: plus(7),
        monthOn,
        staleFifth,
        nextFifth: iso(fifth),
      }
    })
    const modes = [
      {
        task: runScopedMarker('wdio-dot-week'),
        due: dates.tenAgo,
        command: 'REPEAT WEEKLY (from completion)',
      },
      {
        task: runScopedMarker('wdio-plus-week'),
        due: dates.tenAgo,
        command: 'REPEAT WEEKLY (catch-up)',
      },
      {
        task: runScopedMarker('wdio-dot-month'),
        due: dates.fortyAgo,
        command: 'REPEAT MONTHLY (from completion)',
      },
      {
        task: runScopedMarker('wdio-plus-month'),
        due: dates.staleFifth,
        command: 'REPEAT MONTHLY (catch-up)',
      },
    ]
    const ids = await seedTasks(
      page,
      modes.map(({ task, due }) => ({ task, props: [`due_date:: ${due}`] })),
    )
    for (const [i, { command }] of modes.entries()) {
      await editAtEnd(ids[i] ?? '')
      await pickRepeatCommand(command)
    }
    const [first] = modes
    if (first === undefined) throw new Error('no mode to check')
    await reopenPageHolding(page, first.task)
    for (const id of ids) {
      await $(`[data-block-id="${id}"] .repeat-indicator`).waitForExist({
        timeout: NAV_TIMEOUT,
        timeoutMsg: `task ${id} shows no repeat chip after the round-trip`,
      })
    }

    for (const id of ids) await cycleTaskTo(id, 'DONE')
    await reopenPageHolding(page, first.task)
    for (const id of ids) await waitForTaskState(id, 'DONE')

    // Each next occurrence is the open TODO bullet of the task; its due date
    // is the property line under it.
    const source = await openPageSource(modes.map(({ task }) => task))
    const lines = (await pageSourceLines()).map(({ text }) => text)
    const nextDue = (task: string) => {
      const at = lines.findIndex((line) => line.startsWith(`- [ ] ${task}`))
      if (at < 0) return 'no next occurrence'
      for (const line of lines.slice(at + 1)) {
        if (!line.startsWith(' ')) break
        const due = /^\s+due_date:: (\S+)/.exec(line)
        if (due?.[1] !== undefined) return due[1]
      }
      return 'no due date'
    }
    const next = Object.fromEntries(modes.map(({ command, task }) => [command, nextDue(task)]))
    const cancel = pageSourceButton('Cancel')
    await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
    await cancel.click()
    await source.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    expect(next).toEqual({
      'REPEAT WEEKLY (from completion)': dates.inSeven,
      'REPEAT WEEKLY (catch-up)': dates.inFour,
      'REPEAT MONTHLY (from completion)': dates.monthOn,
      'REPEAT MONTHLY (catch-up)': dates.nextFifth,
    })
  })

  it('the rule, repeat-count and repeat-until edited in the drawer drive completion', async () => {
    const page = runScopedMarker('wdio-drawer-page')
    const ruled = runScopedMarker('wdio-drawer-rule')
    const bounded = runScopedMarker('wdio-drawer-until')
    const today = await localDay(0)
    const inSeven = await localDay(7)
    const farOff = await localDay(300)
    const [ruledId, boundedId] = await seedTasks(page, [
      { task: ruled, props: [`due_date:: ${today}`, 'repeat:: daily', 'repeat-count:: 9'] },
      {
        task: bounded,
        props: [`due_date:: ${today}`, 'repeat:: daily', `repeat-until:: ${farOff}`],
      },
    ])
    if (ruledId === undefined || boundedId === undefined) throw new Error('the tasks have no ids')

    // Weekly, and only one more occurrence; the other task ends today.
    await openPropertyDrawer(ruledId)
    await setDrawerField('repeat', 'weekly')
    await setDrawerField('repeat-count', '1')
    await closePropertyDrawer()
    await openPropertyDrawer(boundedId)
    await setDrawerField('repeat-until', today)
    await closePropertyDrawer()

    await reopenPageHolding(page, ruled)
    await openPropertyDrawer(ruledId)
    const ruledAfterReopen = await drawerValues(['repeat', 'repeat-count'])
    await closePropertyDrawer()
    await openPropertyDrawer(boundedId)
    const boundedAfterReopen = await drawerValues(['repeat-until'])
    await closePropertyDrawer()

    await cycleTaskTo(ruledId, 'DONE')
    await cycleTaskTo(boundedId, 'DONE')
    await reopenPageHolding(page, ruled)
    await waitForTaskState(ruledId, 'DONE')
    await waitForTaskState(boundedId, 'DONE')
    const boundedRows = (await taskRows(bounded)).length

    // The next occurrence carries the rule on, its sequence rolled to one.
    const nextId = await occurrenceIn(ruled, 'TODO')
    await openPropertyDrawer(nextId)
    const nextOccurrence = await drawerValues(['due', 'repeat', 'repeat-count', 'repeat-seq'])
    await closePropertyDrawer()

    await cycleTaskTo(nextId, 'DONE')
    await reopenPageHolding(page, ruled)
    await waitForTaskState(nextId, 'DONE')
    const ruledRows = (await taskRows(ruled)).length

    expect({
      ruledAfterReopen,
      boundedAfterReopen,
      nextOccurrence,
      ruledRows,
      boundedRows,
    }).toEqual({
      ruledAfterReopen: { repeat: 'weekly', 'repeat-count': '1' },
      boundedAfterReopen: { 'repeat-until': today },
      nextOccurrence: { due: inSeven, repeat: 'weekly', 'repeat-count': '1', 'repeat-seq': '1' },
      // The one more occurrence the count allows, then none.
      ruledRows: 2,
      // Tomorrow is past the date: completing it made no next occurrence.
      boundedRows: 1,
    })
  })

  // Last: it leaves the journal in Agenda mode, which the Daily-mode tests above step through.
  it('lists the coming week of projected occurrences in Agenda mode, up to each bound', async () => {
    const page = runScopedMarker('wdio-agenda-page')
    const counted = runScopedMarker('wdio-agenda-count')
    const until = runScopedMarker('wdio-agenda-until')
    const open = runScopedMarker('wdio-agenda-open')
    // With no date filter Agenda mode projects today and the six days after.
    const week = await localDays(0, 7)
    const [today, , inTwo] = week
    if (today === undefined || inTwo === undefined) throw new Error('no dates to project over')
    const daily = [`due_date:: ${today}`, 'repeat:: daily']
    await seedTasks(page, [
      { task: counted, props: [...daily, 'repeat-count:: 3'] },
      { task: until, props: [...daily, `repeat-until:: ${inTwo}`] },
      { task: open, props: daily },
    ])

    await navigateTo('Journal')
    const agendaTab = $('button[role="tab"][aria-label="Agenda view"]')
    await agendaTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await agendaTab.click()

    // The unbounded task, projected every day of the week after today, says the
    // projection was read after the save: a cache rebuild still pending answers
    // without the new tasks, and each remount of the view asks again.
    const after = week.slice(1)
    await browser.waitUntil(
      async () => {
        const dates = (await agendaProjectedRows(open)).map((row) => row.date)
        if (dates.join() === after.join()) return true
        await navigateTo('Pages')
        await navigateTo('Journal')
        await $('[data-testid="agenda-view"]').waitForExist({ timeout: NAV_TIMEOUT })
        return false
      },
      {
        timeout: 2 * NAV_TIMEOUT,
        interval: 3_000,
        timeoutMsg: `Agenda mode never projected ${open} over ${after.join(', ')}`,
      },
    )

    const countedRows = await agendaProjectedRows(counted)
    const untilRows = await agendaProjectedRows(until)
    expect({
      counted: countedRows.map((row) => row.date),
      until: untilRows.map((row) => row.date),
      labelled: [...countedRows, ...untilRows].every((row) => row.text.includes('Projected')),
    }).toEqual({
      counted: after.slice(0, 3),
      until: after.slice(0, 2),
      labelled: true,
    })
  })
})
