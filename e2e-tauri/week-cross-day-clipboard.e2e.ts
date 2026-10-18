// ---------------------------------------------------------------------------
// Real-backend block copy, paste and cut across two days of the journal week.
//
// The week view mounts one BlockTree per day, and each tree's chord listener
// used to act on its own share of the one global selection: a cross-day copy
// put only one day on the clipboard, a paste landed once per day, and a cut
// deleted both days with only one on the clipboard. Now the tree that holds the
// anchor (the last selected block) acts for the whole selection, days in
// document order. The Playwright twin is `e2e/week-cross-day-clipboard.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  ctrlClick,
  navigateTo,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TODAY = runScopedMarker('wdio-wek-today')
const OTHER = runScopedMarker('wdio-wek-other')
const EDITOR = '[data-testid="block-editor"]'

/** Text the clipboard plugin holds, read the way the paste chord reads it. */
async function clipboardText(): Promise<string> {
  return await browser.execute(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string | null> }
      }
    ).__TAURI_INTERNALS__
    return (await internals.invoke('plugin:clipboard-manager|read_text')) ?? ''
  })
}

/** The block row in day `day` (a `journal-YYYY-MM-DD` section id) holding `marker`. */
function rowIn(day: string, marker: string) {
  return $(`#${day}`).$(`[data-testid="block-static"]*=${marker}`)
}

/**
 * How many rows of day `day` hold each marker. The day is scrolled into view
 * first: the week mounts a day's tree, and a tree its rows, only on screen.
 */
async function countsIn(day: string): Promise<[number, number]> {
  await $(`#${day}`).scrollIntoView()
  const texts = await browser.execute(
    (id: string) =>
      Array.from(
        document.querySelectorAll(`#${id} [data-testid="block-static"]`),
        (el) => el.textContent ?? '',
      ),
    day,
  )
  return [
    texts.filter((t) => t.includes(TODAY)).length,
    texts.filter((t) => t.includes(OTHER)).length,
  ]
}

async function waitForCounts(day: string, want: [number, number], what: string): Promise<void> {
  let seen: [number, number] = [-1, -1]
  try {
    await browser.waitUntil(
      async () => {
        seen = await countsIn(day)
        return seen[0] === want[0] && seen[1] === want[1]
      },
      { timeout: NAV_TIMEOUT },
    )
  } catch {
    throw new Error(
      `${what}: [today, other] rows in ${day} are [${seen.join(', ')}], want [${want.join(', ')}]`,
    )
  }
}

/** Leave block-select mode's selection and wait for every batch toolbar to go. */
async function clearSelection(): Promise<void> {
  await browser.keys(['Escape'])
  await browser.waitUntil(
    async () => (await $$('[data-testid="batch-toolbar"]').getElements()).length === 0,
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'Escape did not clear the block selection' },
  )
}

/**
 * Ctrl+click the row holding `marker` in each `[day, marker]`, scrolling its
 * day into view first; each day's tree then shows its own batch toolbar.
 */
async function selectAcrossDays(...rows: [string, string][]): Promise<void> {
  for (const [day, marker] of rows) {
    await $(`#${day}`).scrollIntoView()
    const row = rowIn(day, marker)
    await row.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // scrollIntoView aligns to the window's top, under the view header, where
    // a click lands on the header instead of the row.
    await row.scrollIntoView({ block: 'center' })
    await ctrlClick(row)
  }
  await browser.waitUntil(
    async () => (await $$('[data-testid="batch-toolbar"]').getElements()).length === rows.length,
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+click did not select a block in each day' },
  )
}

describe('Agaric real-backend week-view clipboard across two days @editor @journal', () => {
  it('copies, pastes and cuts a selection spanning two days as one', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await addBlockWithMarker(TODAY)

    const weekly = $('button[role="tab"][aria-label="Weekly view"]')
    await weekly.waitForClickable({ timeout: NAV_TIMEOUT })
    await weekly.click()
    await $('section[id^="journal-2"]').waitForExist({ timeout: NAV_TIMEOUT })

    // The week's days in document order, today's, and an empty one. Today is
    // found by date, not by its marker: a day below the fold has not mounted
    // its tree yet (DaySection), so its text holds no block.
    const { days, today, empty } = await browser.execute(() => {
      const d = new Date()
      const todayId = `journal-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const sections = Array.from(document.querySelectorAll('section[id^="journal-2"]'))
      return {
        days: sections.map((s) => s.id),
        today: sections.find((s) => s.id === todayId)?.id ?? '',
        empty: sections.find((s) => (s.textContent ?? '').includes('No blocks for'))?.id ?? '',
      }
    })
    expect(today).not.toBe('')
    expect(empty).not.toBe('')
    await $(`#${today}`).scrollIntoView()
    await rowIn(today, TODAY).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // The empty day's "Add block" creates its page and seeds its first block.
    const otherDay = $(`#${empty}`)
    await otherDay.scrollIntoView()
    await otherDay.$('button*=Add block').click()
    await browser.waitUntil(
      async () => (await $$(`#${empty} [data-testid="sortable-block"]`).getElements()).length === 1,
      { timeout: ACTION_TIMEOUT, timeoutMsg: `Add block did not seed one block row in ${empty}` },
    )
    await typeMarkerVerified(OTHER)
    // Escape leaves the editor with the block selected (#5160 D17); the second
    // Escape clears that selection so the Ctrl+clicks below start from none.
    await browser.keys(['Escape'])
    await $(EDITOR).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await clearSelection()

    const otherFirst = days.indexOf(empty) < days.indexOf(today)
    const [earlierDay, laterDay] = otherFirst ? [empty, today] : [today, empty]
    const [earlier, later] = otherFirst ? [OTHER, TODAY] : [TODAY, OTHER]

    // Copy: the later day holds the anchor, and the clipboard still reads in
    // day order.
    await selectAcrossDays([earlierDay, earlier], [laterDay, later])
    await browser.keys(['Control', 'c'])
    await browser.waitUntil(
      async () => {
        const text = await clipboardText()
        return text.includes(earlier) && text.includes(later)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+C did not put both days on the clipboard' },
    )
    const copied = await clipboardText()
    expect(copied.indexOf(earlier)).toBeLessThan(copied.indexOf(later))

    // Paste: one copy of both blocks, after the anchor in the later day.
    await browser.keys(['Control', 'v'])
    const laterCounts: [number, number] = otherFirst ? [2, 1] : [1, 2]
    await waitForCounts(laterDay, laterCounts, 'Ctrl+V did not paste after the anchor')
    for (const toast of await $$('[data-sonner-toast]').getElements()) {
      expect(await toast.getText()).not.toContain('Failed to paste blocks')
    }

    // The durable read: once, and only in the later day.
    await navigateTo('Tags')
    await navigateTo('Journal')
    await waitForCounts(laterDay, laterCounts, 'the pasted copy is not in the later day once')
    await waitForCounts(
      earlierDay,
      otherFirst ? [0, 1] : [1, 0],
      'the earlier day changed on paste',
    )

    // Cut the two originals (the view change cleared the selection): the
    // clipboard holds both before either goes.
    await selectAcrossDays([earlierDay, earlier], [laterDay, later])
    await browser.keys(['Control', 'x'])
    await waitForCounts(earlierDay, [0, 0], 'Ctrl+X left the earlier day’s block')
    const cut = await clipboardText()
    expect(cut).toContain(earlier)
    expect(cut).toContain(later)
    expect(cut.indexOf(earlier)).toBeLessThan(cut.indexOf(later))

    // The durable read: the pasted copies alone remain, in the later day.
    await navigateTo('Tags')
    await navigateTo('Journal')
    await waitForCounts(laterDay, [1, 1], 'the cut did not remove the later day’s original')
    await waitForCounts(earlierDay, [0, 0], 'the cut block came back in the earlier day')
  })
})
