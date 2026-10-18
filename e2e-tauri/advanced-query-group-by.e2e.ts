// ---------------------------------------------------------------------------
// Real-backend Advanced Query: group by state, with a Count aggregate (#5738).
//
// Grouped mode buckets the matches in SQL (`run_grouped`,
// agaric-store/src/query/engine.rs): one `GROUP BY` row per state with its
// count and its per-group aggregates, plus a global aggregate over the
// ungrouped matches. The mock synthesises one bucket keyed by the group type
// (src/lib/tauri-mock/handlers/search.ts), so only this lane shows real
// buckets. This spec imports tasks in several states, scopes the query to
// them with a full-text term, groups by state and adds a Count, and reads the
// headers and chips again after leaving the view and coming back.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  importMarkdownPage,
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-grouped')
// Not containing MARKER, so the page's own title row does not match the term.
const TITLE = runScopedMarker('wdio-query-doc')
const TASKS = [
  ['TODO', 'one'],
  ['TODO', 'two'],
  ['TODO', 'six'],
  ['DOING', 'ten'],
  ['DOING', 'win'],
  ['DONE', 'cup'],
] as const

// Buckets come back in `gcount DESC, gkey ASC` order.
const BUCKETS = [
  ['TODO', 3],
  ['DOING', 2],
  ['DONE', 1],
] as const

/**
 * The bucket headers as `groupViews` reads them, with each bucket's Count
 * chip when `counted`.
 */
function expectedGroups(counted: boolean): string[] {
  return BUCKETS.map(([key, n]) =>
    [key, n === 1 ? '1 block' : `${n} blocks`, ...(counted ? [`Count: ${n}`] : [])].join(' | '),
  )
}

/** Pages › Advanced Query (a Pages header button), ready once the view mounts. */
async function openAdvancedQuery(): Promise<void> {
  await navigateTo('Pages')
  const open = $('.page-browser-header button[aria-label="Advanced Query"]')
  await open.waitForClickable({ timeout: NAV_TIMEOUT })
  await open.click()
  await $('[data-testid="advanced-query-view"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Each group section's header (GroupedResults.tsx) as `key | count label |
 * chip…`: the key, the count beside it, and the per-group aggregate chips.
 */
function groupViews(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="advanced-query-group-section"]')].map(
      (section) => {
        const header = section.querySelector('header')
        const chips = header?.querySelectorAll(
          '[data-testid="advanced-query-group-aggregates"] [data-testid="advanced-query-aggregate-chip"]',
        )
        return [
          header?.querySelector('[data-testid="advanced-query-group-key"]')?.textContent ?? '',
          header?.children[1]?.textContent ?? '',
          ...[...(chips ?? [])].map((chip) => chip.textContent ?? ''),
        ].join(' | ')
      },
    ),
  )
}

/** The global aggregate bar's chips. */
function globalChips(): Promise<string[]> {
  return browser.execute(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="advanced-query-aggregate-summary"] [data-testid="advanced-query-aggregate-chip"]',
      ),
    ].map((chip) => chip.textContent ?? ''),
  )
}

/** Wait until the groups and the global chips read `groups` and `global`. */
async function waitForGroups(groups: string[], global: string[], when: string): Promise<void> {
  const want = JSON.stringify({ groups, global })
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = JSON.stringify({ groups: await groupViews(), global: await globalChips() })
        return seen === want
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the grouped results read ${seen}, not ${want}`)
    })
}

describe('Agaric real-backend Advanced Query grouping (#5738)', () => {
  it('groups the matches by state with per-group counts and a Count aggregate', async () => {
    await waitForAppReady()
    const markdown = TASKS.map(([state, name]) => `- ${state} ${MARKER} ${name}`).join('\n')
    expect(await importMarkdownPage(TITLE, `${markdown}\n`)).toContain(`${TASKS.length} blocks`)

    await openAdvancedQuery()
    await typeInputVerified('[data-testid="advanced-query-fulltext"]', MARKER)
    // The FTS rows are written by the background materializer after the
    // import; a remount re-runs the query (`refetchOnMount: 'always'`).
    const total = $('[data-testid="advanced-query-total"]')
    const scoped = `${TASKS.length} matching blocks`
    await browser.waitUntil(
      async () => {
        const matched = await browser
          .waitUntil(async () => (await total.isExisting()) && (await total.getText()) === scoped, {
            timeout: 5_000,
          })
          .then(
            () => true,
            () => false,
          )
        if (!matched) await openAdvancedQuery()
        return matched
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: `the full-text term never matched: ${scoped}` },
    )

    await chooseSelectOption('[data-testid="advanced-query-group"]', 'State')
    await waitForGroups(expectedGroups(false), [], 'grouped by state')
    // Grouped mode's total counts the buckets, not the blocks in them.
    const grouped = `${BUCKETS.length} groups`
    await expect(total).toHaveText(grouped)

    const addAggregate = $('[data-testid="advanced-query-aggregates"]').$('button=Add aggregate')
    await addAggregate.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addAggregate.click()
    await waitForGroups(expectedGroups(true), [`Count: ${TASKS.length}`], 'with a Count aggregate')

    // Away and back: the view remounts and asks the backend again.
    await navigateTo('Journal')
    await openAdvancedQuery()
    await waitForGroups(
      expectedGroups(true),
      [`Count: ${TASKS.length}`],
      'after navigating away and back',
    )
    await expect($('[data-testid="advanced-query-total"]')).toHaveText(grouped)
  })
})
