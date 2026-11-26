import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  activeSheet,
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  reopenPage,
  settleBackend,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * #5366, #5734, #5735, #5736 — repeating tasks: projection, anchoring modes and the drawer.
 *
 * A TODO due today that repeats occurs again later, and the Due panel of that day lists it as a
 * `projected-entry` (DuePanel.tsx) from `list_projected_agenda`; Agenda mode lists the same
 * projection over the coming week. The projection stops at `repeat-until` and after
 * `repeat-count` occurrences. The mock answers that command with an empty page, so those tests
 * are `@real-only`.
 *
 * Completing a repeating task makes its next occurrence in the same transaction: `.+` counts the
 * interval from today, `++` steps the stale date forward until it passes today, and the rule and
 * bounds edited in the property drawer are the ones completion reads. The mock makes the same
 * occurrence (`src/lib/tauri-mock/recurrence.ts`), so those tests run on both.
 *
 * Each task lives on a page of its own: the journal's Due panel leaves out the day's own blocks.
 */

const SPACE = SEED_IDS.SPACE_PERSONAL
const SCOPE = { kind: 'active', space_id: SPACE }

/** The local calendar day `offset` days from today, as `YYYY-MM-DD`. */
function localDay(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return iso(d)
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The local calendar day `offset` days from today as the drawer's date field shows it at rest:
 * as the date chips do, "Dec 3", with the year when it is not this year's (#7040 O7).
 */
function chipDay(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  })
}

/** Local calendar days `from` to `from + count - 1` from today. */
function localDays(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => localDay(from + i))
}

interface SeededTask {
  task: string
  due: string
  repeat?: string
  count?: number
  until?: string
  /** Tags at the start of its text, each a chip before the text. */
  tags?: string[]
}

/** Create page `title` holding each of `tasks` as an open TODO, and return the page's and the tasks' ids. */
async function seedTasks(
  page: Page,
  title: string,
  tasks: SeededTask[],
): Promise<{ pageId: string; ids: string[] }> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SPACE,
  })
  const ids: string[] = []
  for (const { task, due, repeat, count, until, tags = [] } of tasks) {
    const chips: string[] = []
    for (const tag of tags) {
      const row = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'tag',
        content: tag,
        parentId: null,
        index: null,
        scope: SCOPE,
        blockId: null,
      })
      chips.push(`#[${row.id}] `)
    }
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: `${chips.join('')}${task}`,
      parentId: pageId,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
    await ipc(page, 'set_todo_state', { blockId: id, state: 'TODO' })
    await ipc(page, 'set_due_date', { blockId: id, date: due })
    const props: Array<[string, Record<string, unknown>]> = []
    if (repeat !== undefined) props.push(['repeat', { value_text: repeat }])
    if (count !== undefined) props.push(['repeat-count', { value_num: count }])
    if (until !== undefined) props.push(['repeat-until', { value_date: until }])
    for (const [key, value] of props) await ipc(page, 'set_property', { blockId: id, key, value })
    ids.push(id)
  }
  await settleBackend(page)
  return { pageId, ids }
}

interface TaskRow {
  id: string
  content: string | null
  todo_state: string | null
  due_date: string | null
}

/** The page's tasks whose text holds `task`, as the backend reads them now. */
async function rowsOf(page: Page, pageId: string, task: string): Promise<TaskRow[]> {
  const { items } = await ipc<{ items: TaskRow[] }>(page, 'list_blocks', {
    request: {
      parentId: pageId,
      blockType: null,
      tagId: null,
      date: null,
      dateRange: null,
      source: null,
      excludeTodoStates: null,
      cursor: null,
      limit: 100,
    },
    scope: SCOPE,
  })
  return items.filter((row) => (row.content ?? '').includes(task))
}

/** Click block `id`'s task checkbox until it reads `state`. */
async function cycleTaskTo(page: Page, id: string, state: string): Promise<void> {
  const marker = page.locator(`[data-block-id="${id}"] [data-testid="task-marker"]`)
  for (let click = 0; click < 5; click++) {
    const label = (await marker.getAttribute('aria-label')) ?? ''
    if (label.startsWith(`Task: ${state}.`)) return
    await marker.click()
    await expect(marker).not.toHaveAttribute('aria-label', label)
  }
  throw new Error(`the task checkbox never reached ${state}`)
}

/** The texts of the projected entries in the Due panel of journal day `day`. */
function projectedEntries(page: Page, day: string) {
  return page.locator(`section[id="journal-${day}"] [data-testid="projected-entry"]`)
}

/** Open the Daily journal on today, then step one "Next day" to each of `days`. */
async function stepJournalOver(page: Page, days: string[]): Promise<void> {
  await navigateToView(page, 'Journal')
  await page.getByRole('button', { name: 'Go to today' }).click()
  await expect(page.locator(`section[id="journal-${localDay(0)}"]`)).toBeVisible()
  for (const day of days) {
    await page.getByRole('button', { name: 'Next day' }).click()
    await expect(page.locator(`section[id="journal-${day}"]`)).toBeVisible()
  }
}

async function openPropertyDrawer(page: Page, id: string) {
  await page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`).click({
    button: 'right',
  })
  await activeMenu(page).getByRole('menuitem', { name: 'Properties' }).click()
  const sheet = activeSheet(page)
  await expect(sheet.getByText('Block properties')).toBeVisible()
  return sheet
}

async function closePropertyDrawer(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog').filter({ hasText: 'Block properties' })).toHaveCount(0)
}

/** Replace the open drawer's `key` value with `value`; Enter blurs the field, which saves it. */
async function setDrawerField(page: Page, key: string, value: string): Promise<void> {
  const input = activeSheet(page).locator(`input[data-testid="property-value-input-${key}"]`)
  await input.fill(value)
  await input.press('Enter')
}

/** The open drawer's value for each of `keys`. */
async function drawerValues(page: Page, keys: string[]): Promise<Record<string, string>> {
  const sheet = activeSheet(page)
  const values: Record<string, string> = {}
  for (const key of keys) {
    const input =
      key === 'due'
        ? sheet.locator('input[aria-label="Due value"]')
        : sheet.locator(`input[data-testid="property-value-input-${key}"]`)
    await expect(input).toBeVisible()
    values[key] = await input.inputValue()
  }
  return values
}

test.describe('Repeating tasks (#5366, #5734, #5735, #5736) @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test(
    'stops projecting a daily task after its repeat-until date and its repeat-count',
    { tag: '@real-only' },
    async ({ page }) => {
      const days = localDays(0, 5)
      const [today, inOne, inTwo, inThree, inFour] = days as [
        string,
        string,
        string,
        string,
        string,
      ]
      const daily = { due: today, repeat: 'daily' }
      await seedTasks(page, 'Bounds page', [
        { task: 'count three', ...daily, count: 3 },
        { task: 'until two', ...daily, until: inTwo },
        { task: 'unbounded', ...daily },
      ])

      const seen: Record<string, string[]> = {}
      await stepJournalOver(page, [])
      for (const day of days.slice(1)) {
        await page.getByRole('button', { name: 'Next day' }).click()
        // The unbounded task, projected every day, says the day's panel has answered.
        const entries = projectedEntries(page, day)
        await expect(entries.filter({ hasText: 'unbounded' })).toBeVisible()
        seen[day] = (await entries.allTextContents())
          .map((text) => ['count three', 'until two'].find((task) => text.includes(task)))
          .filter((task) => task !== undefined)
          .toSorted()
      }
      expect(seen).toEqual({
        [inOne]: ['count three', 'until two'],
        [inTwo]: ['count three', 'until two'],
        [inThree]: ['count three'],
        [inFour]: [],
      })
    },
  )

  test(
    'lists a weekly TODO due today as projected in the Due panel a week out',
    { tag: '@real-only' },
    async ({ page }) => {
      const days = localDays(1, 7)
      await seedTasks(page, 'Weekly page', [
        { task: 'weekly chore', due: localDay(0), repeat: '+1w' },
      ])
      await stepJournalOver(page, days)
      await expect(
        projectedEntries(page, localDay(7)).filter({ hasText: 'weekly chore' }),
      ).toBeVisible()
    },
  )

  test('/repeat .+ counts from today and ++ steps past stale dates, weekly and monthly', async ({
    page,
  }) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // A month on from today keeps the day, clamped to the month's length.
    const y = today.getFullYear()
    const m = today.getMonth() + 1
    const monthOn = iso(new Date(y, m, Math.min(today.getDate(), new Date(y, m + 1, 0).getDate())))
    // The 5th never clamps, so stepping it a month at a time stays on the 5th.
    let fifth = new Date(y, today.getMonth() - 2, 5)
    const staleFifth = iso(fifth)
    while (fifth <= today) fifth = new Date(fifth.getFullYear(), fifth.getMonth() + 1, 5)
    const modes = [
      { task: 'dot week', due: localDay(-10), command: 'REPEAT WEEKLY (from completion)' },
      { task: 'plus week', due: localDay(-10), command: 'REPEAT WEEKLY (catch-up)' },
      { task: 'dot month', due: localDay(-40), command: 'REPEAT MONTHLY (from completion)' },
      { task: 'plus month', due: staleFifth, command: 'REPEAT MONTHLY (catch-up)' },
    ]
    const { pageId, ids } = await seedTasks(page, 'Anchor page', modes)

    await openPage(page, 'Anchor page')
    for (const [i, { command }] of modes.entries()) {
      await focusBlockById(page, ids[i] ?? '')
      const list = await typeSlashCommand(page, 'repeat')
      await list.getByTestId('suggestion-item').filter({ hasText: command }).click()
      await page.keyboard.press('Escape')
      await expect(
        page.locator(`[data-block-id="${ids[i]}"] .repeat-indicator`),
        `${command} put no repeat chip on its task`,
      ).toBeVisible()
    }
    for (const id of ids) await cycleTaskTo(page, id, 'DONE')
    await settleBackend(page)

    const next: Record<string, string | null> = {}
    for (const { task, command } of modes) {
      const open = (await rowsOf(page, pageId, task)).filter((row) => row.todo_state === 'TODO')
      next[command] = open.length === 1 ? (open[0]?.due_date ?? null) : `${open.length} open`
    }
    expect(next).toEqual({
      'REPEAT WEEKLY (from completion)': localDay(7),
      'REPEAT WEEKLY (catch-up)': localDay(4),
      'REPEAT MONTHLY (from completion)': monthOn,
      'REPEAT MONTHLY (catch-up)': iso(fifth),
    })
  })

  test('the rule, repeat-count and repeat-until edited in the drawer drive completion', async ({
    page,
  }) => {
    const today = localDay(0)
    const {
      pageId,
      ids: [ruledId = '', boundedId = ''],
    } = await seedTasks(page, 'Drawer page', [
      { task: 'ruled task', due: today, repeat: 'daily', count: 9 },
      { task: 'bounded task', due: today, repeat: 'daily', until: localDay(300) },
    ])

    // Weekly, and only one more occurrence; the other task ends today.
    await openPage(page, 'Drawer page')
    await openPropertyDrawer(page, ruledId)
    await setDrawerField(page, 'repeat', 'weekly')
    await setDrawerField(page, 'repeat-count', '1')
    await closePropertyDrawer(page)
    await openPropertyDrawer(page, boundedId)
    await setDrawerField(page, 'repeat-until', today)
    await closePropertyDrawer(page)
    await settleBackend(page)

    await reopenPage(page, 'Drawer page')
    await openPropertyDrawer(page, ruledId)
    const ruledAfterReopen = await drawerValues(page, ['repeat', 'repeat-count'])
    await closePropertyDrawer(page)
    await openPropertyDrawer(page, boundedId)
    const boundedAfterReopen = await drawerValues(page, ['repeat-until'])
    await closePropertyDrawer(page)

    await cycleTaskTo(page, ruledId, 'DONE')
    await cycleTaskTo(page, boundedId, 'DONE')
    await settleBackend(page)
    const boundedRows = (await rowsOf(page, pageId, 'bounded task')).length

    // The next occurrence carries the rule on, its sequence rolled to one.
    await reopenPage(page, 'Drawer page')
    const nextId =
      (await rowsOf(page, pageId, 'ruled task')).find((row) => row.todo_state === 'TODO')?.id ??
      'no next occurrence'
    await openPropertyDrawer(page, nextId)
    const nextOccurrence = await drawerValues(page, ['due', 'repeat', 'repeat-count', 'repeat-seq'])
    await closePropertyDrawer(page)

    await cycleTaskTo(page, nextId, 'DONE')
    await settleBackend(page)
    const ruledRows = (await rowsOf(page, pageId, 'ruled task')).length

    expect({
      ruledAfterReopen,
      boundedAfterReopen,
      nextOccurrence,
      ruledRows,
      boundedRows,
    }).toEqual({
      ruledAfterReopen: { repeat: 'weekly', 'repeat-count': '1' },
      boundedAfterReopen: { 'repeat-until': today },
      nextOccurrence: {
        due: chipDay(7),
        repeat: 'weekly',
        'repeat-count': '1',
        'repeat-seq': '1',
      },
      // The one more occurrence the count allows, then none.
      ruledRows: 2,
      // Tomorrow is past the date: completing it made no next occurrence.
      boundedRows: 1,
    })
  })

  test(
    'lists the coming week of projected occurrences in Agenda mode, up to each bound',
    { tag: '@real-only' },
    async ({ page }) => {
      // With no date filter Agenda mode projects today and the six days after.
      const after = localDays(1, 6)
      const daily = { due: localDay(0), repeat: 'daily' }
      await seedTasks(page, 'Agenda page', [
        { task: 'agenda count', ...daily, count: 3 },
        { task: 'agenda until', ...daily, until: localDay(2) },
        { task: 'agenda open', ...daily },
      ])
      await navigateToView(page, 'Journal')
      await page.getByRole('tab', { name: 'Agenda view' }).click()

      const rows = (task: string) =>
        page.evaluate(
          (marker) =>
            [
              ...document.querySelectorAll(
                '[data-testid="agenda-view"] [data-testid="projected-entry"]',
              ),
            ]
              .filter((row) => (row.textContent ?? '').includes(marker))
              .map((row) => ({
                date: row.querySelector('time')?.getAttribute('datetime') ?? '',
                labelled: (row.textContent ?? '').includes('Projected'),
              })),
          task,
        )
      await expect
        .poll(async () => (await rows('agenda open')).map((row) => row.date))
        .toEqual(after)
      const counted = await rows('agenda count')
      const until = await rows('agenda until')
      expect({
        counted: counted.map((row) => row.date),
        until: until.map((row) => row.date),
        labelled: [...counted, ...until].every((row) => row.labelled),
      }).toEqual({ counted: after.slice(0, 3), until: after.slice(0, 2), labelled: true })
    },
  )
})

// #6532: the row's text is one truncated line, and what clips it must not clip the chips' touch area.
test.describe('Repeating tasks on a phone (#6532) @journal @mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true })

  test(
    "a projected row's tag chips take a 44 px touch area in a 360 px window, on one truncated line",
    { tag: '@real-only' },
    async ({ page }) => {
      await waitForBoot(page)
      const task = 'chips on a projected row that truncates in a narrow window'
      await seedTasks(page, 'Chips page', [
        { task, tags: ['pa', 'pb'], due: localDay(0), repeat: 'daily' },
      ])
      await stepJournalOver(page, [localDay(1)])
      const row = projectedEntries(page, localDay(1)).filter({ hasText: task })
      await expect(row).toBeVisible()

      const measured = await row.evaluate((li) => {
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
      })
      expect(measured).toEqual({
        rowHeight: 44,
        truncated: true,
        drawnUnder30: true,
        aboveBelow: ['chip 0', 'chip 0', 'chip 1', 'chip 1'],
        between: ['row', 'row', 'row'],
      })
    },
  )
})
