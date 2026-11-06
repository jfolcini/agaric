// ---------------------------------------------------------------------------
// Real-backend labelled link in a table cell lists its block in the target
// page's Linked References.
//
// A link typed in a table cell with a label is stored as `[[ULID\|label]]`:
// the table writer escapes every pipe in a cell so the row keeps its columns.
// The backend's link scan read that escaped separator as part of the id, so the
// block got no `block_links` row, and the target's Linked References never
// listed it (it showed under Unlinked References, or nowhere). `block_links`
// and the references query are the backend's; the mock lane's twin
// (`e2e/table-cell-link-backlink.spec.ts`) runs the mock's own link scan, so
// only this lane shows the real index.
//
// Persistence is a nav round-trip: the source page is left and reopened (the
// table is re-read from the stored text), then the target page is opened and
// its panel re-queried; nothing reloads.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  distinctKeyChunks,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
  waitForPickerToOffer,
} from './helpers'

const SOURCE = runScopedMarker('wdio-tcl-source')
const TARGET = runScopedMarker('wdio-tcl-target')
const LABEL = runScopedMarker('wdio-tcl-shown')

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const FIRST_HEADER_CELL = '[data-testid="block-editor"] th'
const PANEL = '[data-testid="linked-references"]'

/** The text of the first header cell of the table being edited. */
function firstHeaderCellText(): Promise<string> {
  return browser.execute(
    (sel: string) => document.querySelector(sel)?.textContent ?? '',
    FIRST_HEADER_CELL,
  )
}

/**
 * Type `text` with the caret in the new table's first header cell and verify it
 * landed: `typeMarkerVerified` reads the whole editor, which a table pads with
 * its empty cells. A dropped key erases what landed and retries one key at a time.
 */
async function typeInFirstHeaderCell(text: string): Promise<void> {
  const MAX_TYPE_ATTEMPTS = 3
  let seen = ''
  for (let attempt = 1; attempt <= MAX_TYPE_ATTEMPTS; attempt++) {
    const chunks = attempt === 1 ? distinctKeyChunks(text) : Array.from(text)
    for (const chunk of chunks) {
      await browser.keys(Array.from(chunk))
      await browser.pause(40)
    }
    try {
      await browser.waitUntil(async () => (seen = await firstHeaderCellText()) === text, {
        timeout: 3_000,
        interval: 200,
      })
    } catch {
      // Still not the text after the budget: `seen` decides below.
    }
    if (seen === text) return
    for (let i = 0; i < seen.length; i++) await browser.keys(['Backspace'])
  }
  throw new Error(
    `the table cell never held the typed link: expected=${JSON.stringify(text)} ` +
      `lastSeen=${JSON.stringify(seen)}`,
  )
}

/** The id of the block whose editor or static render holds `selector`, or null. */
function owningBlockId(selector: string): Promise<string | null> {
  return browser.execute(
    (sel: string) =>
      document.querySelector(sel)?.closest('[data-block-id]')?.getAttribute('data-block-id') ??
      null,
    selector,
  )
}

/** The rows of the open page's Linked References panel: block id and text. */
function listedReferences(): Promise<{ id: string; text: string }[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(selector)].map((row) => ({
        id: row.getAttribute('data-backlink-item') ?? '',
        text: row.textContent ?? '',
      })),
    `${PANEL} li[data-backlink-item]`,
  )
}

describe('Agaric real-backend labelled link in a table cell is a backlink @editor @pages', () => {
  it('lists the block holding the table in the target page’s Linked References', async () => {
    await waitForAppReady()
    await openNewPage(TARGET)
    await openNewPage(SOURCE)

    // `/table` then the picker's 3×3 grid; Enter inserts it with the caret in
    // the first header cell.
    await $(EDITOR).click()
    for (const ch of '/table') await browser.keys([ch])
    const item = $('#suggestion-table')
    await item.waitForClickable({ timeout: ACTION_TIMEOUT })
    await item.click()
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const active = document.activeElement
          return (
            active?.getAttribute('role') === 'grid' &&
            active.getAttribute('aria-label') === 'Insert table'
          )
        }),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the table size grid never took focus' },
    )
    await browser.keys(['Enter'])
    await $('[data-testid="block-editor"] table').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // The `]]` closes the link and resolves the name through the picker's
    // search, so wait until it offers the target page that exists.
    await typeInFirstHeaderCell(`[[${TARGET}|${LABEL}`)
    await waitForPickerToOffer(TARGET)
    // WebKit coalesces two identical keys sent together (`typeVerified`), so the
    // `]]` goes one key at a time.
    await browser.keys([']'])
    await browser.pause(40)
    await browser.keys([']'])
    await $(
      `${FIRST_HEADER_CELL} [data-testid="block-link-chip"][data-label="${LABEL}"]`,
    ).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    const edited = await owningBlockId(EDITOR)
    if (edited === null) throw new Error('the table editor is not inside a block')
    await browser.keys(['Escape'])
    await $(`[data-testid="block-static"][data-block-id="${edited}"]`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })

    // Away and back: the table is re-read from the stored text, chip and all.
    await navigateTo('Journal')
    await reopenPageByTitle(SOURCE)
    // The static chip carries no data-label, so it is found by the label it shows.
    await browser.waitUntil(
      async () => {
        const chips = await $$('[data-testid="rich-table"] th [data-testid="block-link-chip"]')
        for (const chip of chips) {
          if ((await chip.getText()).includes(LABEL)) return true
        }
        return false
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: `the static table never showed the chip ${LABEL}` },
    )
    expect(await owningBlockId('[data-testid="rich-table"]')).toBe(edited)

    // The target's panel lists that block. The links are indexed after the save
    // commits, and a panel that loaded before them stays empty until it is
    // mounted again, so leave and reopen until it lists the block.
    let seen: { id: string; text: string }[] = []
    await browser
      .waitUntil(
        async () => {
          await navigateTo('Journal')
          await reopenPageByTitle(TARGET)
          return browser
            .waitUntil(
              async () => {
                seen = await listedReferences()
                return seen.some((row) => row.id === edited)
              },
              { timeout: 5_000, interval: 250 },
            )
            .then(
              () => true,
              () => false,
            )
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(
          `${TARGET}'s Linked References never listed the table block ${edited}; ` +
            `it listed ${JSON.stringify(seen)}`,
        )
      })
    const row = seen.find((r) => r.id === edited)
    expect(row?.text).toContain(LABEL)
  })
})
