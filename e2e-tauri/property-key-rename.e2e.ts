// ---------------------------------------------------------------------------
// Real-backend: renaming a property key in Settings › Properties (#5841 S2).
//
// Two journal blocks, siblings of a text block, get a `project:: <value>`
// line each, typed and blurred with Escape, which stores an undeclared text
// property. Settings ›
// Properties then declares `project` as text and renames it to `area`:
// `rename_property_key` moves the definition and every value the space's
// blocks hold, in the engine and in SQL. After leaving the journal and coming
// back, the blocks are read again from the backend: each value's chip is
// named `Area`, and no chip is named `Project`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  editAtEnd,
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

const ANCHOR = runScopedMarker('wdio-rename-anchor')
const VALUES = [runScopedMarker('wdio-rename-one'), runScopedMarker('wdio-rename-two')]
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const PANEL = '[data-testid="settings-panel-properties"]'
const CREATE_KEY = `${PANEL} input[aria-label="Property key"]`
const NEW_KEY = '[role="dialog"] input[aria-label="New property key"]'

/** The chip named `<Key>: <value>`, the chip's accessible name (PropertyChip.tsx). */
const chip = (name: string) => `[data-testid="property-chip"][aria-label="${name}"]`

describe('Agaric real-backend property key rename (#5841) @settings @editor', () => {
  it('moves every block’s value to the new key, read again after a round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    // Each `project::` line goes into its own blank sibling of a text block:
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
      await typeMarkerVerified(`project:: ${value}`)
      await browser.keys(['Escape'])
      await $(chip(`Project: ${value}`)).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    }

    // Declare `project` as text, the type the create form starts on.
    await openSettingsTab('properties')
    await typeInputVerified(CREATE_KEY, 'project')
    const create = $(PANEL).$('button*=Create')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()

    const rename = $(`${PANEL} button[aria-label="Rename property project"]`)
    await rename.waitForClickable({ timeout: ACTION_TIMEOUT })
    await rename.click()
    // The dialog opens focused on the current key; empty it before typing the
    // new one. Wait for the focus rather than click: the dialog still animates.
    await browser.waitUntil(
      () =>
        browser.execute(
          (sel: string) => document.activeElement === document.querySelector(sel),
          NEW_KEY,
        ),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the rename input never took focus' },
    )
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeInputVerified(NEW_KEY, 'area')
    const save = $('[role="dialog"]').$('button*=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await waitForToast('Renamed project to area')

    await navigateTo('Pages')
    await navigateTo('Journal')
    for (const value of VALUES) {
      await $(chip(`Area: ${value}`)).waitForDisplayed({
        timeout: NAV_TIMEOUT,
        timeoutMsg: `the block holding ${value} shows no area chip after the round-trip`,
      })
    }
    await expectAbsent('[data-testid="property-chip"][aria-label^="Project:"]', 'a project chip')
  })
})
