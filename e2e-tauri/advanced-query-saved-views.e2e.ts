// ---------------------------------------------------------------------------
// Real-backend Advanced Query saved views (#5738).
//
// "Save view" stores the query spec in the active space's saved views on this
// device (`src/lib/saved-query-views.ts`); Saved views lists them
// (SavedViews.tsx), and Load parses the stored spec back into the builder and
// re-runs it against the real engine. Saved views once never listed on the
// real backend while the mock lane stayed green (#5738), so the round trip is
// pinned here too.
//
// Advanced Query opens from the Pages header's "Advanced Query" button
// (PageBrowserHeader.tsx); a result row is `[data-testid="query-result-item"]`
// (QueryResultList.tsx) and a saved view `[data-testid="saved-view-row"]`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const PAGE = runScopedMarker('wdio-aq-page')
const TASK = runScopedMarker('wdio-aq-task')
const NOTE = runScopedMarker('wdio-aq-note')
const VIEW = runScopedMarker('wdio-aq-saved')

const ROOT = '[role="group"][aria-label="Filter"]'
const STATE_LEAF = `${ROOT} [role="group"][aria-label="state: TODO"]`
const NAME_INPUT = 'input[aria-label="Name this view:"]'

/** The Saved views row named `name` (SavedViews.tsx). */
function savedViewRow(name: string): string {
  return `//*[@data-testid="saved-view-row"][./span[normalize-space(.)="${name}"]]`
}

/** Open Advanced Query from the Pages header and wait for its builder. */
async function openAdvancedQuery(): Promise<void> {
  await navigateTo('Pages')
  const button = $('button[aria-label="Advanced Query"]')
  await button.waitForClickable({ timeout: NAV_TIMEOUT })
  await button.click()
  await $(ROOT).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Wait until the results show every one of `shown` and none of `hidden`. */
async function waitForResults(shown: string[], hidden: string[], what: string): Promise<void> {
  let rows: string[] = []
  await browser
    .waitUntil(
      async () => {
        rows = await browser.execute(() =>
          [...document.querySelectorAll('[data-testid="query-result-item"]')].map(
            (row) => row.textContent ?? '',
          ),
        )
        const has = (marker: string) => rows.some((text) => text.includes(marker))
        return shown.every(has) && !hidden.some(has)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: the results were ${JSON.stringify(rows)}`)
    })
}

/** Add a root leaf matching blocks whose todo state is TODO. */
async function addTodoStateLeaf(): Promise<void> {
  const add = $(ROOT).$('button[aria-label="Add filter"]')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  const popover = $('[role="dialog"][aria-label="Add a filter"]')
  const facet = popover.$('.//button[starts-with(normalize-space(.), "State")]')
  await facet.waitForClickable({ timeout: ACTION_TIMEOUT })
  await facet.click()
  const todo = popover.$('button[role="checkbox"][aria-label="TODO"]')
  await todo.waitForClickable({ timeout: ACTION_TIMEOUT })
  await todo.click()
  const apply = popover.$('button=Apply')
  await apply.waitForClickable({ timeout: ACTION_TIMEOUT })
  await apply.click()
  await $(STATE_LEAF).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend Advanced Query saved views (#5738) @search', () => {
  before(async () => {
    await waitForAppReady()
    // A page with one TODO block and one plain block: the State leaf keeps the
    // first and drops the second.
    await openNewPage(PAGE)
    await typeMarkerVerified(TASK)
    await enterBlankSibling()
    await typeMarkerVerified(NOTE)
    await navigateTo('Journal')
    await reopenPageByTitle(PAGE)
    const task = blockStaticByMarker(TASK)
    await task.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await task.getAttribute('data-block-id')
    const checkbox = $(`[data-block-id="${id}"]`).$('[data-testid="task-marker"]')
    await checkbox.waitForExist({ timeout: NAV_TIMEOUT })
    await checkbox.moveTo()
    await checkbox.click()
    await browser.waitUntil(
      async () => ((await checkbox.getAttribute('aria-label')) ?? '').startsWith('Task:'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the task checkbox never set a todo state' },
    )
  })

  it('lists a saved view after a round trip, and Load restores its tree and results', async () => {
    await openAdvancedQuery()
    await waitForResults([TASK, NOTE], [], 'the empty builder did not match both blocks')
    await addTodoStateLeaf()
    await waitForResults([TASK], [NOTE], 'the State leaf did not narrow the results')

    const save = $('button[aria-label="Save the current query as a named view"]')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await typeInputVerified(NAME_INPUT, VIEW)
    const confirm = $('[role="dialog"]').$('button=Save')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await waitForToast(`Saved view "${VIEW}"`)

    // Clear the builder so only Load can bring the leaf back.
    const clear = $('button[aria-label="Clear all"]')
    await clear.waitForClickable({ timeout: ACTION_TIMEOUT })
    await clear.click()
    await waitForResults([TASK, NOTE], [], 'Clear all did not widen the results again')

    await navigateTo('Journal')
    await openAdvancedQuery()
    const row = $(savedViewRow(VIEW))
    await row.waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `Saved views does not list ${VIEW} after the round trip`,
    })
    await expectAbsent(STATE_LEAF, 'the cleared State leaf')

    const load = row.$(`button[aria-label='Load "${VIEW}"']`)
    await load.waitForClickable({ timeout: ACTION_TIMEOUT })
    await load.click()
    await waitForToast(`Loaded view "${VIEW}"`)
    await $(STATE_LEAF).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Load did not restore the State leaf',
    })
    await waitForResults([TASK], [NOTE], 'Load did not restore the narrowed results')
  })
})
