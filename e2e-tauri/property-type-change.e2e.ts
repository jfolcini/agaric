// ---------------------------------------------------------------------------
// Real-backend: changing a property's type in Settings › Properties (#5841 S3).
//
// Settings › Properties declares `points` as text. Two journal blocks,
// siblings of a text block, then get a `points:: <value>` line each, typed and
// blurred with Escape: `3` and a marker. Changing `points` to number previews
// one value converted and one that doesn't fit, and the Don't fit tab lists
// the marker. `change_property_type` writes the definition and every value in
// one op, through the engine and SQL. After leaving the journal and coming
// back, the blocks are read again from the backend: `3` is still a `Points`
// chip, and the marker is kept as text, still a `Points` chip (#6206).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  editAtEnd,
  enterBlankSibling,
  navigateTo,
  openJournalBlockEditor,
  openSettingsTab,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const ANCHOR = runScopedMarker('wdio-retype-anchor')
const UNFIT = runScopedMarker('wdio-retype-word')
const VALUES = ['3', UNFIT]
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const PANEL = '[data-testid="settings-panel-properties"]'
const CREATE_KEY = `${PANEL} input[aria-label="Property key"]`
const DIALOG = '[role="dialog"]'

/** The chip named `<Key>: <value>`, the chip's accessible name (PropertyChip.tsx). */
const chip = (name: string) => `[data-testid="property-chip"][aria-label="${name}"]`

/** Whether the open dialog's text includes `text`, read in one command. */
async function dialogShows(text: string): Promise<boolean> {
  return browser.execute(
    (sel: string, wanted: string) =>
      (document.querySelector(sel)?.textContent ?? '').includes(wanted),
    DIALOG,
    text,
  )
}

describe('Agaric real-backend property type change (#5841) @settings @editor', () => {
  it('converts the values that fit and keeps the rest as text, read again after a round-trip', async () => {
    await waitForAppReady()

    // Declare `points` as text, the type the create form starts on.
    await openSettingsTab('properties')
    await typeInputVerified(CREATE_KEY, 'points')
    const create = $(PANEL).$('button*=Create')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()
    await $(`${PANEL} button[aria-label="Change the type of points"]`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })

    await navigateTo('Journal')
    // Each `points::` line goes into its own blank sibling of a text block:
    // a block whose only text is a property line is empty, and "Add block"
    // puts the cursor back into it rather than creating a second block.
    await openJournalBlockEditor()
    await typeMarkerVerified(ANCHOR)
    const anchorId = await browser.execute(
      (sel: string) =>
        document.querySelector(sel)?.closest('[data-block-id]')?.getAttribute('data-block-id') ??
        null,
      EDITOR,
    )
    if (anchorId === null) throw new Error('the anchor block has no id')
    for (const [i, value] of VALUES.entries()) {
      if (i > 0) await editAtEnd(anchorId)
      await enterBlankSibling()
      await typeMarkerVerified(`points:: ${value}`)
      await browser.keys(['Escape'])
      await $(chip(`Points: ${value}`)).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    }

    await openSettingsTab('properties')
    const change = $(`${PANEL} button[aria-label="Change the type of points"]`)
    await change.waitForClickable({ timeout: ACTION_TIMEOUT })
    await change.click()
    await chooseSelectOption(`${DIALOG} [aria-label="New type"]`, 'number')
    await browser.waitUntil(
      async () =>
        (await dialogShows('1 value is converted.')) &&
        (await dialogShows("1 value isn't a number")) &&
        (await dialogShows(UNFIT)),
      {
        timeout: ACTION_TIMEOUT,
        timeoutMsg:
          "the dialog never previewed 1 converted and 1 that doesn't fit, listing the marker",
      },
    )
    const confirm = $(DIALOG).$('button*=Change type')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await waitForToast('Changed points to number')

    await navigateTo('Pages')
    await navigateTo('Journal')
    await $(chip('Points: 3')).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the block holding 3 shows no points chip after the round-trip',
    })
    await $(chip(`Points: ${UNFIT}`)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: "the block holding the value that doesn't fit shows no points chip",
    })
  })
})
