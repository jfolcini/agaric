// ---------------------------------------------------------------------------
// Real-backend References panel: Status, Priority and their `none` (#5736).
//
// A task's state and priority live in `blocks.todo_state` / `blocks.priority`,
// so the panel's builder sends `TodoState` / `Priority`, and `none` as
// `Not(Or(<every state or level>))` (AddFilterRow.tsx). The backend compiles
// `Not` as `NOT COALESCE((inner), 0)` (backlink/filters.rs), so a block whose
// column is NULL joins the complement instead of dropping out; the mock
// evaluates `Not` in JS, so only this lane shows the SQL. This spec imports
// sources linking one page and reads the panel for each filter, the Priority
// ones after leaving the page and coming back.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  importMarkdownPage,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-ref')
const SOURCE = runScopedMarker('wdio-ref-source')
const TARGET = runScopedMarker('wdio-ref-target')
// `[#A]` / `[#B]` import as priority 1 / 2, the definition's first two levels.
const SOURCES = {
  'todo-high': `TODO [#A] ${MARKER}-todo-high`,
  'todo-medium': `TODO [#B] ${MARKER}-todo-medium`,
  'done-high': `DONE [#A] ${MARKER}-done-high`,
  // A state but no priority, so `none` for Status and for Priority differ.
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

/** Add one builder filter: `category`, then the option whose text holds `value`. */
async function addFilter(category: 'Status' | 'Priority', value: string): Promise<void> {
  const add = $(PANEL).$('button[aria-label="Add filter"]')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  await chooseSelectOption('[aria-label="Filter category"]', category)
  await chooseSelectOption(`[aria-label="${category} value"]`, value)
  const apply = $(PANEL).$('button[aria-label="Apply filter"]')
  await apply.waitForClickable({ timeout: ACTION_TIMEOUT })
  await apply.click()
}

async function clearFilters(): Promise<void> {
  const clear = $(PANEL).$('button[aria-label="Clear all filters and sort"]')
  await clear.waitForClickable({ timeout: ACTION_TIMEOUT })
  await clear.click()
  await waitForListed(ALL, '', 'after Clear all')
}

describe('Agaric real-backend References Status / Priority filters (#5736)', () => {
  it('lists exactly the sources each Status, Priority and none filter selects', async () => {
    await waitForAppReady()
    const markdown = Object.values(SOURCES)
      .map((source) => `- ${source} links [[${TARGET}]]`)
      .join('\n')
    expect(await importMarkdownPage(SOURCE, `${markdown}\n`)).toContain(`${ALL.length} blocks`)

    await openTarget()
    await addFilter('Status', 'TODO')
    await waitForListed(
      ['todo-high', 'todo-medium', 'todo-bare'],
      'Showing 3 of 5 backlinks',
      'Status TODO',
    )
    await clearFilters()
    await addFilter('Status', 'None')
    await waitForListed(['plain'], 'Showing 1 of 5 backlinks', 'Status none')

    // Away and back: the panel remounts with no filter and reads the backend again.
    await openTarget()
    await addFilter('Priority', 'High')
    await waitForListed(['todo-high', 'done-high'], 'Showing 2 of 5 backlinks', 'Priority High')
    await clearFilters()
    await addFilter('Priority', 'None')
    await waitForListed(['todo-bare', 'plain'], 'Showing 2 of 5 backlinks', 'Priority none')
  })
})
