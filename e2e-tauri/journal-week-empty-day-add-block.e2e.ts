// ---------------------------------------------------------------------------
// Real-backend week view: "Add block" on a day with no journal page.
//
// One click created only the day's page: the day then sat on "Creating first
// block…" (reduced motion) or stayed blank (lazy mount) until a second click.
// This spec clicks once and asserts a focused editor in that day, exactly one
// block there, and that the typed block survives a nav round-trip.
// Playwright twin: `e2e/journal-week-empty-day-add-block.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-week-empty-day')

/** Open the journal's week view (`JournalControls`, `journalTabId('weekly')`). */
async function openWeekView(): Promise<void> {
  const tab = $('#journal-tab-weekly')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: 'the Weekly view tab never became selected',
  })
}

/** The id of the first week day still showing its no-page empty state. */
async function firstEmptyDayId(): Promise<string> {
  let found: string | undefined
  await browser.waitUntil(
    async () => {
      for (const day of await $$('section[id^="journal-"]').getElements()) {
        if ((await day.getText()).includes('No blocks for')) {
          found = (await day.getAttribute('id')) ?? undefined
          return true
        }
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: 'the week view shows no day without a page' },
  )
  if (found === undefined) throw new Error('no empty week day found')
  return found
}

describe('Agaric real-backend week view empty-day Add block', () => {
  it('creates and focuses one block in that day on a single click', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openWeekView()

    const day = `section[id="${await firstEmptyDayId()}"]`
    const addBlock = $(day).$('button*=Add block')
    await addBlock.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addBlock.click()

    const editor = `${day} [data-testid="block-editor"] [contenteditable="true"]`
    await $(editor).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(
      () =>
        browser.execute((sel) => document.activeElement === document.querySelector(sel), editor),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the new block editor never took focus' },
    )
    expect((await $$(`${day} [data-testid="sortable-block"]`).getElements()).length).toBe(1)
    expect(await $(day).getText()).not.toContain('Creating first block')

    await typeMarkerVerified(MARKER)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await $(day).$(`[data-testid="block-static"]*=${MARKER}`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })

    // Durable: the block is re-read from the backend after a nav round-trip.
    await navigateTo('Pages')
    await navigateTo('Journal')
    await openWeekView()
    // Week days mount their blocks only once scrolled into view.
    await $(day).scrollIntoView()
    const persisted = blockStaticByMarker(MARKER)
    await persisted.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(persisted).toBeDisplayed()
  })
})
