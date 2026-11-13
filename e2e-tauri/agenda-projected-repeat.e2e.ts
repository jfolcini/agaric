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
// that completion reads. The mock makes the same occurrence
// (`src/lib/tauri-mock/recurrence.ts`), but only this lane projects it.
//
// Each task lives on a page of its own: the journal's Due panel leaves out
// the day's own blocks (`excludePageId`). Checkboxes, dates and rules are
// seeded in one Edit as Markdown save, the way `block-duplicate-repeat` sets
// its rule. The tests share one vault, so each writes its own titled page.
//
// The bounds test runs before the weekly one: the Due panel keeps a day's
// projection for `PROJECTED_CACHE_TTL_MS`, so stepping over days 1 to 7 first
// would leave days 1 to 4 holding an answer from before the bounds test's
// tasks existed, and that test would wait out the TTL. What the file still
// costs is its real round-trips (seed, drawer edit, complete, reopen), a few
// seconds each, which is what it proves.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  cycleTaskTo,
  dismissToasts,
  distinctKeyChunks,
  editAtEnd,
  navigateTo,
  occurrenceIn,
  openPropertyDrawer,
  openNewPage,
  openPageSource,
  clickPageSourceButton,
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

const REMOUNT_AFTER_MS = 3_000

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
  /** Tags named at the start of its line, each a chip before the text. */
  tags?: string[]
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
  for (const [i, { task, props, tags = [] }] of tasks.entries()) {
    const chips = tags.map((tag) => `#${tag} `).join('')
    lines.push({ text: `- [ ] ${chips}${task}`, id: i === 0 ? firstId : null })
    for (const prop of props) lines.push({ text: `  ${prop}`, id: null })
  }
  lines.push({ text: '', id: null })
  await setPageSourceLines(lines)
  await clickPageSourceButton('Save')
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
 * of `expected`. A freshly shown day answers asynchronously, so the panel is
 * polled in place first; the panel also keeps a day's projection for
 * `PROJECTED_CACHE_TTL_MS` (useDuePanelData.ts), so an answer from before the
 * cache rebuild can be served again for that long: a poll that stays empty past
 * `REMOUNT_AFTER_MS` remounts the view, which asks again.
 */
async function projectedOnceHolding(day: string, expected: string[]): Promise<string[]> {
  let texts: string[] = []
  let mountedAt = Date.now()
  await browser.waitUntil(
    async () => {
      texts = await projectedTexts(day)
      if (expected.every((task) => texts.some((text) => text.includes(task)))) return true
      if (Date.now() - mountedAt < REMOUNT_AFTER_MS) return false
      await navigateTo('Pages')
      await navigateTo('Journal')
      await $(`section[id="journal-${day}"]`).waitForExist({ timeout: NAV_TIMEOUT })
      mountedAt = Date.now()
      return false
    },
    {
      timeout: 2 * NAV_TIMEOUT,
      interval: 250,
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

/**
 * Apply every `(pointer: coarse)` rule of the app's stylesheets, as a touch
 * screen does: the lane's webview may report a fine pointer, and nothing
 * WebDriver offers changes that. What `useIsTouch` answers stays as it was.
 */
async function applyCoarsePointerRules(): Promise<void> {
  const rewritten = await browser.execute(() => {
    let count = 0
    const visit = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && /\(pointer:\s*coarse\)/.test(rule.media.mediaText)) {
          rule.media.mediaText = rule.media.mediaText.replace(
            /\(pointer:\s*coarse\)/g,
            '(min-width: 0px)',
          )
          count += 1
        }
        if ('cssRules' in rule) visit(rule.cssRules as CSSRuleList)
      }
    }
    for (const sheet of document.styleSheets) visit(sheet.cssRules)
    return count
  })
  if (rewritten === 0) throw new Error('the stylesheets hold no (pointer: coarse) rule')
}

/** Open the Daily journal on today, `today`. */
async function showJournalToday(today: string): Promise<void> {
  await navigateTo('Journal')
  const goToToday = $('button[aria-label="Go to today"]')
  await goToToday.waitForClickable({ timeout: NAV_TIMEOUT })
  await goToToday.click()
  await $(`section[id="journal-${today}"]`).waitForExist({ timeout: NAV_TIMEOUT })
}

/** Step the Daily journal forward one day to `day`. */
async function nextJournalDay(day: string): Promise<void> {
  const next = $('button[aria-label="Next day"]')
  await next.waitForClickable({ timeout: NAV_TIMEOUT })
  await next.click()
  await $(`section[id="journal-${day}"]`).waitForExist({ timeout: NAV_TIMEOUT })
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

    await showJournalToday(today)

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
        .map(({ text, id }) => ({ id, text: text.includes(TASK) ? `- [ ] ${text}` : text })),
      ...[`  due_date:: ${today}`, '  repeat:: +1w', ''].map((text) => ({ text, id: null })),
    ])
    await clickPageSourceButton('Save')
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
    await showJournalToday(today)
    for (const day of days.slice(1)) await nextJournalDay(day)

    const projected = () =>
      $(`section[id="journal-${weekOut}"]`).$(`[data-testid="projected-entry"]*=${TASK}`)
    await projectedOnceHolding(weekOut, [TASK])
    await expect(projected()).toBeDisplayed()
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
    // is the `📅` signifier on its line (#6277 decision 4).
    const source = await openPageSource(modes.map(({ task }) => task))
    const lines = (await pageSourceLines()).map(({ text }) => text)
    const nextDue = (task: string) => {
      const line = lines.find((text) => text.startsWith(`- [ ] ${task}`))
      if (line === undefined) return 'no next occurrence'
      return / 📅 (\S+)/.exec(line)?.[1] ?? 'no due date'
    }
    const next = Object.fromEntries(modes.map(({ command, task }) => [command, nextDue(task)]))
    await clickPageSourceButton('Cancel')
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

  // #6532: the row's text is one truncated line, and what clips it must not
  // clip the chips' touch area.
  it("a projected row's tag chips take a 44 px touch area in a 360 px window, on one truncated line", async () => {
    const page = runScopedMarker('wdio-chips-page')
    const task = runScopedMarker('wdio-chips-on-a-projected-row-that-truncates')
    // Past the days the tests above stepped through, whose panels may still
    // hold an answer from before this task existed.
    const days = await localDays(0, 10)
    const [today] = days
    const day = days.at(-1)
    if (today === undefined || day === undefined) throw new Error('no dates to step through')
    await seedTasks(page, [
      { task, tags: ['pa', 'pb'], props: [`due_date:: ${today}`, 'repeat:: daily'] },
    ])
    await showJournalToday(today)
    for (const next of days.slice(1)) await nextJournalDay(next)
    await projectedOnceHolding(day, [task])

    const size = await browser.getWindowSize()
    await browser.setWindowSize(360, 780)
    try {
      await browser.waitUntil(
        async () => (await browser.execute(() => window.innerWidth)) === 360,
        {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: 'the window never became 360 px wide',
        },
      )
      await applyCoarsePointerRules()
      // The save's Undo toast lies over the foot of a narrow window.
      await dismissToasts()
      const row = $(`section[id="journal-${day}"]`).$(`[data-testid="projected-entry"]*=${task}`)
      await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
      const measured = await browser.execute(
        (li: HTMLElement) => {
          // A point outside the viewport hits nothing.
          li.scrollIntoView({ block: 'center' })
          const chips = [...li.querySelectorAll<HTMLElement>('.tag-ref-chip')]
          const text = li.querySelector<HTMLElement>('.tag-chip-row')
          const [a, b] = chips.map((chip) => chip.getBoundingClientRect())
          if (a === undefined || b === undefined || text === null) return null
          const hit = (x: number, y: number) => {
            const at = document.elementFromPoint(x, y)
            const chip = chips.findIndex((el) => el.contains(at))
            if (chip !== -1) return `chip ${chip}`
            return li.contains(at) ? 'row' : 'outside the row'
          }
          const middle = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const
          return {
            rowHeight: li.getBoundingClientRect().height,
            truncated: text.scrollWidth > text.clientWidth,
            drawnUnder30: chips.every((chip) => chip.getBoundingClientRect().height < 30),
            // 21 px above and below each chip's middle: a 44 px box less a pixel.
            aboveBelow: [a, b].flatMap((r) => {
              const [x, y] = middle(r)
              return [hit(x, y - 21), hit(x, y + 21)]
            }),
            // Just past each chip and midway between them, at their middle.
            between: [a.right + 1, (a.right + b.left) / 2, b.left - 1].map((x) =>
              hit(x, middle(a)[1]),
            ),
          }
        },
        await row,
      )
      expect(measured).toEqual({
        rowHeight: 44,
        truncated: true,
        drawnUnder30: true,
        aboveBelow: ['chip 0', 'chip 0', 'chip 1', 'chip 1'],
        between: ['row', 'row', 'row'],
      })
    } finally {
      await browser.setWindowSize(size.width, size.height)
    }
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
