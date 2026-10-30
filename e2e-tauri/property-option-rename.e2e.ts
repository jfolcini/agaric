// ---------------------------------------------------------------------------
// Real-backend: renaming a select option in Settings › Properties (#5841 S4).
//
// Settings › Properties declares `stage` as a select of draft and review. A
// journal block, a sibling of a text block, gets a `stage:: review` line,
// typed and blurred with Escape, which stores the select value. Edit options
// then renames review to in_review: `rename_property_option` renames the
// option in the definition and every value the space's blocks hold, in the
// engine and in SQL. After leaving the journal and coming back, the block is
// read again from the backend: its chip reads `Stage: in_review`, and no chip
// reads `Stage: review`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  openSettingsTab,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const ANCHOR = runScopedMarker('wdio-option-anchor')
const PANEL = '[data-testid="settings-panel-properties"]'
const EDITOR_POPOVER = '[data-slot="popover-content"]'
const NEW_NAME = `${EDITOR_POPOVER} input[aria-label="New name for review"]`

/** The chip named `<Key>: <value>`, the chip's accessible name (PropertyChip.tsx). */
const chip = (name: string) => `[data-testid="property-chip"][aria-label="${name}"]`

describe('Agaric real-backend select option rename (#5841) @settings @editor', () => {
  it('renames the value a block holds, read again after a round-trip', async () => {
    await waitForAppReady()

    // Declare `stage` as a select of draft and review.
    await openSettingsTab('properties')
    await typeInputVerified(`${PANEL} input[aria-label="Property key"]`, 'stage')
    await chooseSelectOption(`${PANEL} [aria-label="Type"]`, 'select')
    await typeInputVerified(
      `${PANEL} input[aria-label="Options, comma-separated"]`,
      'draft, review',
    )
    const create = $(PANEL).$('button*=Create')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()
    await waitForToast('Property definition created')

    // A block whose only text is a property line is empty, and "Add block"
    // puts the cursor back into it, so the line goes into a blank sibling of
    // a text block.
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(ANCHOR)
    await enterBlankSibling()
    await typeMarkerVerified('stage:: review')
    await browser.keys(['Escape'])
    await $(chip('Stage: review')).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await openSettingsTab('properties')
    const editOptions = $(PANEL).$('li*=Stage').$('button[aria-label="Edit options"]')
    await editOptions.waitForClickable({ timeout: ACTION_TIMEOUT })
    await editOptions.click()
    const rename = $(`${EDITOR_POPOVER} button[aria-label="Rename option review"]`)
    await rename.waitForClickable({ timeout: ACTION_TIMEOUT })
    await rename.click()
    // The field opens focused on the current name; empty it before typing.
    await browser.waitUntil(
      () =>
        browser.execute(
          (sel: string) => document.activeElement === document.querySelector(sel),
          NEW_NAME,
        ),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the option name input never took focus' },
    )
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeInputVerified(NEW_NAME, 'in_review')
    const save = $(`${EDITOR_POPOVER} button[aria-label="Save option name"]`)
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await waitForToast('Renamed review to in_review in stage')
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    await $(chip('Stage: in_review')).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the block holding review shows no in_review chip after the round-trip',
    })
    await expectAbsent(chip('Stage: review'), 'a chip with the old option name')
  })
})
