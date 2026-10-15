// ---------------------------------------------------------------------------
// Real-backend projected occurrence of a weekly task (#5366).
//
// A TODO due today that repeats every week occurs again a week out, and the
// Due panel of that day lists it as a `projected-entry` (DuePanel.tsx) from
// `list_projected_agenda`: the `projected_agenda_cache` the materializer
// rebuilds, or the on-the-fly projector when that cache does not cover the
// day. The mock answers the command with an empty page
// (`e2e/journal-panels.spec.ts`), so only this lane shows the projection.
//
// The task lives on a page of its own: the journal's Due panel leaves out the
// day's own blocks (`excludePageId`). Its checkbox, due date and rule are set in
// one Edit as Markdown save, the way `block-duplicate-repeat` sets its rule.
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
  reopenPageByTitle,
  runScopedMarker,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK = runScopedMarker('wdio-projected')
const TASK_ROW = `[data-testid="sortable-block"]*=${TASK}`

/** Leave the page editor and come back, so the task row is the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(TASK_ROW).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

describe('Agaric real-backend projected repeat (#5366)', () => {
  it('lists a weekly TODO due today as projected in the Due panel a week out', async () => {
    await waitForAppReady()
    // Today and the next seven days, spelled as the journal's day-section ids.
    const days = await browser.execute(() =>
      Array.from({ length: 8 }, (_, offset) => {
        const d = new Date()
        d.setDate(d.getDate() + offset)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }),
    )
    const [today] = days
    const weekOut = days.at(-1)
    if (today === undefined || weekOut === undefined) throw new Error('no dates to step through')

    // The sidebar click commits the typed task by blurring the editor.
    await openNewPage()
    await typeMarkerVerified(TASK)
    await reopenTheNewPage()

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
    await reopenTheNewPage()
    await $(TASK_ROW).$('.repeat-indicator').waitForExist({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the saved task shows no repeat chip',
    })

    // Daily mode (the default) steps one day per "Next day" (JournalControls).
    await navigateTo('Journal')
    const next = $('button[aria-label="Next day"]')
    for (const day of days.slice(1)) {
      await next.waitForClickable({ timeout: NAV_TIMEOUT })
      await next.click()
      await $(`section[id="journal-${day}"]`).waitForExist({ timeout: NAV_TIMEOUT })
    }

    // The panel keeps a day's projection for 30 s (`PROJECTED_CACHE_TTL_MS`,
    // useDuePanelData.ts), so an answer from before the cache rebuild can be
    // served again for that long: the wait outlasts it, and each remount asks.
    const projected = () =>
      $(`section[id="journal-${weekOut}"]`).$(`[data-testid="projected-entry"]*=${TASK}`)
    await browser.waitUntil(
      async () => {
        if (await projected().isExisting()) return true
        await navigateTo('Pages')
        await navigateTo('Journal')
        return false
      },
      {
        timeout: 2 * NAV_TIMEOUT,
        interval: 3_000,
        timeoutMsg: `the Due panel of ${weekOut} never projected the weekly task due ${today}`,
      },
    )
    await expect(projected()).toBeDisplayed()
  })
})
