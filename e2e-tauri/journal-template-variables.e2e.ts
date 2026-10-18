// ---------------------------------------------------------------------------
// Real-backend journal template variables on a past day (#5735).
//
// The backend copies the journal template under a day as it creates it, and
// expands the template's variables against that day, not the clock
// (`expand_journal_template_variables`, commands/journal.rs). This spec flags
// a template whose one block carries the date variables, creates a past day
// from the journal's date picker, and reads the day's expanded block back
// after a nav round-trip. A day other than today is what tells "the day" from
// "now".
//
// Its own file: the backend copies only the oldest flagged journal template,
// so a template another case of the same vault flagged would shadow this one.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARK = runScopedMarker('wdio-jvar')
const TEMPLATE_LINE = `${MARK} <% weekday %> <% date+1 %> <% today:EEEE, MMMM d, yyyy %> {{title}}{{cursor}}`
// Far enough back that `date+1` is not today either, so every variable tells
// the day from the clock.
const DAYS_BACK = 3

/** `d` as the local `YYYY-MM-DD` the journal names a day by. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysFrom(d: Date, days: number): Date {
  const at = new Date(d)
  at.setDate(at.getDate() + days)
  return at
}

describe('Agaric real-backend journal template variables (#5735)', () => {
  it('a past day from the date picker expands the template variables for that day', async () => {
    await waitForAppReady()
    const today = new Date()
    const day = daysFrom(today, -DAYS_BACK)
    const weekday = day.toLocaleDateString('en-US', { weekday: 'long' })
    const month = day.toLocaleDateString('en-US', { month: 'long' })
    const expected =
      `${MARK} ${weekday} ${isoDay(daysFrom(day, 1))} ` +
      `${weekday}, ${month} ${day.getDate()}, ${day.getFullYear()} ${isoDay(day)}`

    // 1. The template: a page with the variables block, flagged from the kebab.
    await openNewPage(runScopedMarker('wdio-jvar-template'))
    await typeMarkerVerified(TEMPLATE_LINE)
    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    const setTemplate = $('button*=Set as journal template')
    await setTemplate.waitForClickable({ timeout: ACTION_TIMEOUT })
    await setTemplate.click()
    await waitForToast('Set as journal template')

    // 2. The past day, picked in the journal's date picker and created by its CTA.
    await navigateTo('Journal')
    const chip = $('button[aria-label$="Open calendar picker"]')
    await chip.waitForClickable({ timeout: ACTION_TIMEOUT })
    await chip.click()
    const picker = $('[role="dialog"][aria-label="Date picker"]')
    await picker.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    if (day.getMonth() !== today.getMonth()) {
      await picker.$('button[aria-label="Go to the Previous Month"]').click()
    }
    const cell = picker.$(`[role="gridcell"][data-day="${isoDay(day)}"] button`)
    await cell.waitForClickable({ timeout: ACTION_TIMEOUT })
    await cell.click()
    const section = `section[id="journal-${isoDay(day)}"]`
    const addFirst = $(section).$('button*=Add your first block')
    await addFirst.waitForClickable({ timeout: NAV_TIMEOUT })
    await addFirst.click()
    await $(section).$('[data-testid="block-editor"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // 3. The day, re-read after a nav round-trip: the template's block with
    //    every variable resolved for the day.
    await navigateTo('Pages')
    await navigateTo('Journal')
    const expanded = $(section).$(`[data-testid="block-static"]*=${MARK}`)
    await expanded.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await expanded.getText()).toBe(expected)
  })
})
