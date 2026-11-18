// ---------------------------------------------------------------------------
// Real-backend References panel: the Created date filter (#5736).
//
// Created date sends `CreatedInRange`, which the backend compares against the
// time in each block's ULID id, a bound being that day's UTC midnight. The
// mock's ids carry no time, so neither the mock lane nor the bridge's mock
// twin can run it; it moves to the bridge with a `@real-only` tag (#6926 G2).
// Status, Priority, their `none` and a short Contains term are in
// `e2e/references-filters.spec.ts`, on the bridge.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  importLogseqPage,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-ref')
const SOURCE = runScopedMarker('wdio-ref-source')
const TARGET = runScopedMarker('wdio-ref-target')
const SOURCES = {
  'todo-high': `TODO [#A] ${MARKER}-todo-high`,
  'todo-medium': `TODO [#B] ${MARKER}-todo-medium`,
  'done-high': `DONE [#A] ${MARKER}-done-high`,
  'todo-bare': `TODO ${MARKER}-todo-bare`,
  plain: `${MARKER}-plain`,
} as const
type Source = keyof typeof SOURCES
const ALL = Object.keys(SOURCES) as Source[]

const PANEL = '[data-testid="linked-references"]'

/** The sources the panel lists, by name, sorted. */
async function listedSources(): Promise<string[]> {
  const texts = await browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(selector)].map((row) => row.textContent ?? ''),
    `${PANEL} li[data-backlink-item] .linked-reference-item-text`,
  )
  return texts
    .map((text) => ALL.find((name) => text.includes(`${MARKER}-${name} `)) ?? `unknown: ${text}`)
    .toSorted()
}

/** The builder's "Showing N of M backlinks", or '' while no filter is applied. */
async function showing(): Promise<string> {
  const count = $(`${PANEL} .filter-count`)
  return (await count.isExisting()) ? count.getText() : ''
}

/** Wait until the panel lists exactly `sources` under the count line `count`. */
async function waitForListed(sources: Source[], count: string, when: string): Promise<void> {
  const want = JSON.stringify({ sources: sources.toSorted(), count })
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = JSON.stringify({ sources: await listedSources(), count: await showing() })
        return seen === want
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the References panel read ${seen}, not ${want}`)
    })
}

/**
 * Open TARGET and wait for its panel to list every source. The links are
 * indexed after the import commits, and a panel that loaded before them stays
 * empty until it is mounted again, so leave and reopen until it lists them.
 */
async function openTarget(): Promise<void> {
  await browser.waitUntil(
    async () => {
      await navigateTo('Journal')
      await reopenPageByTitle(TARGET)
      return browser
        .waitUntil(async () => (await listedSources()).length === ALL.length, { timeout: 5_000 })
        .then(
          () => true,
          () => false,
        )
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `${TARGET}'s References never listed its sources` },
  )
  await waitForListed(ALL, '', 'with no filter')
}

/** Add one builder filter: pick `category`, fill its form with `fill`, apply. */
async function addFilterWith(category: string, fill: () => Promise<void>): Promise<void> {
  const add = $(PANEL).$('button[aria-label="Add filter"]')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  await chooseSelectOption('[aria-label="Filter category"]', category)
  await fill()
  const apply = $(PANEL).$('button[aria-label="Apply filter"]')
  await apply.waitForClickable({ timeout: ACTION_TIMEOUT })
  await apply.click()
}

/**
 * `YYYY-MM-DD` of the UTC day `days` from now. The backend reads a bound as
 * that day's UTC midnight, so two days either side of now brackets every block
 * this run creates, in any time zone.
 */
function utcDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Set a date input the way React reads it, the native setter and then an
 * `input` event: WebKitGTK's date field takes no WebDriver keys and stays
 * empty, as its time field does (reminder-due-task.e2e.ts).
 */
async function setDateInput(label: string, value: string): Promise<void> {
  const selector = `${PANEL} input[aria-label="${label}"]`
  await $(selector).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.execute(
    (sel: string, date: string) => {
      const input = document.querySelector<HTMLInputElement>(sel)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, date)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )
  expect(await $(selector).getValue()).toBe(value)
}

/** Add a Created date filter; an omitted bound stays open. */
async function addCreatedFilter(range: { after?: string; before?: string }): Promise<void> {
  await addFilterWith('Created date', async () => {
    if (range.after) await setDateInput('Date after', range.after)
    if (range.before) await setDateInput('Date before', range.before)
  })
}

async function clearFilters(): Promise<void> {
  const clear = $(PANEL).$('button[aria-label="Clear all filters and sort"]')
  await clear.waitForClickable({ timeout: ACTION_TIMEOUT })
  await clear.click()
  await waitForListed(ALL, '', 'after Clear all')
}

describe('Agaric real-backend References Created date filter (#5736) @pages @search', () => {
  it('lists the sources created inside a Created date range and none outside it', async () => {
    await waitForAppReady()
    const markdown = Object.values(SOURCES)
      .map((source) => `- ${source} links [[${TARGET}]]`)
      .join('\n')
    expect(await importLogseqPage(SOURCE, `${markdown}\n`)).toContain(`${ALL.length} blocks`)

    await openTarget()
    await addCreatedFilter({ after: utcDay(-2), before: utcDay(2) })
    await waitForListed(ALL, 'Showing 5 of 5 backlinks', 'Created from two days ago to two ahead')
    await clearFilters()
    await addCreatedFilter({ before: utcDay(-2) })
    await waitForListed([], 'Showing 0 of 5 backlinks', 'Created before two days ago')
    await clearFilters()
    await addCreatedFilter({ after: utcDay(2) })
    await waitForListed([], 'Showing 0 of 5 backlinks', 'Created after two days ahead')
  })
})
