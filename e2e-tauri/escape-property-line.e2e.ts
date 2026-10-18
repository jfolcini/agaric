// ---------------------------------------------------------------------------
// Real-backend: Escape on a new block whose only text is a `key:: value` line
// keeps the block (#5448).
//
// Escape flushes the block through the property branch of `runUnmountFlush`,
// which writes the stripped text only after `set_property` answers over real
// IPC. BlockTree's empty-block cleanup (`empty-block-cleanup.ts`) runs on the
// same focus change; before #5448 it saw a blank block with no property in
// that window and soft-deleted it with `{ undoable: false }`, while the
// property was stored on the deleted row. The mock answers IPCs in
// microtasks, so only this lane has the window the bug lived in.
//
// The arms share one vault (a later `it` sees the earlier ones' data). The
// CONTROL presses Escape on a blank block an Enter created and asserts the
// cleanup removed it: that is what proves the cleanup runs under this exact
// sequence (`document.hasFocus()` true in the WebView, the delete landing
// before the round-trip), so the second arm cannot pass by the cleanup never
// firing. The second arm types a `key:: value` line as the only text of a
// fresh block, presses Escape, and after a navigation round-trip asserts a
// property chip carrying the value is listed and no block holds the line as
// text.
//
// The third arm (#5365) builds the line through the `::` picker (#2675) and
// blurs by clicking another block. The save is two writes, `set_property` and
// then the edit that strips the line (`commitInlineProperties`); the arm
// fails if either lands without the other. The picker offers only keys some
// block already holds, so the arm first sets `location` through `/location`,
// which writes the property without the save-time parser.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  distinctKeyChunks,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeMarkerVerified,
  typeVerified,
  waitForAppReady,
  waitForPickerToOffer,
  waitForToast,
} from './helpers'

const CONTROL_MARKER = runScopedMarker('wdio-blank-escape')
// A key no definition spells or folds to is a custom text property, which the
// backend accepts as typed. The value is the run-scoped marker.
const VALUE = runScopedMarker('wdio-escape-prop')
const LINE = `wdiokey:: ${VALUE}`
// Property chips render in the block's metadata row (BlockMetadataRow), outside
// its `block-static` text, so a chip holding VALUE and no static text holding it
// is "stripped and stored".
const VALUE_CHIP = `[data-testid="property-chip"]*=${VALUE}`

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const PICKER_SEED = runScopedMarker('wdio-picker-seed')
const PICKED_VALUE = runScopedMarker('wdio-picked')
// What the picker leaves in the block once `location` is picked.
const PICKED_KEY = 'location:: '

/** The editor's text as typed, its trailing space kept. */
function editorText(): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', EDITOR)
}

/** The chip of block `id` named `<Key>: <value>`, the chip's accessible name. */
function chipOf(id: string, name: string) {
  return $(
    `[data-testid="sortable-block"][data-block-id="${id}"] ` +
      `[data-testid="property-chip"][aria-label="${name}"]`,
  )
}

describe('Agaric real-backend key:: value lines (#5448, #2675) @editor', () => {
  it('control: Escape on a blank block an Enter created cleans it up', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(CONTROL_MARKER)
    const blank = `[data-block-id="${await enterBlankSibling()}"]`
    await browser.keys(['Escape'])

    // The cleanup's delete is optimistic, so the row leaves the DOM as soon as
    // the metadata probes resolve; wait for that before the round-trip, or
    // the navigation could unmount the tree under the probes.
    await expectAbsent(blank, 'the blank control block')

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(CONTROL_MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(blank, 'the blank control block')
  })

  it('keeps a block whose only text was a key:: value line, as the property', async () => {
    await openJournalBlockEditor()
    await typeMarkerVerified(LINE)
    await browser.keys(['Escape'])

    // Blurred, the block renders static with its chip once the property is
    // stored and the line stripped; the cleanup's probes ran on the same
    // focus change.
    await $(VALUE_CHIP).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(CONTROL_MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await $(VALUE_CHIP).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`[data-testid="block-static"]*=${VALUE}`, 'the line kept as text')
  })

  it('stores a key picked through :: as the property and strips the line (#5365)', async () => {
    // The key the picker will offer, written by the slash command alone.
    await openJournalBlockEditor()
    for (const ch of '/location') await browser.keys([ch])
    const office = $('[data-testid="suggestion-item"]*=LOCATION Office')
    await office.waitForClickable({ timeout: ACTION_TIMEOUT })
    await office.click()
    await waitForToast('Set location to Office')
    await typeMarkerVerified(PICKER_SEED)
    const id = await enterBlankSibling()

    for (const chunk of distinctKeyChunks('::loc')) await browser.keys(Array.from(chunk))
    await waitForPickerToOffer('location')
    // WebdriverIO's `*=` text match takes no attribute selector, so read the text.
    await browser.waitUntil(
      async () => {
        const selected = $('[data-testid="suggestion-item"][aria-selected="true"]')
        return (await selected.isExisting()) && (await selected.getText()).includes('location')
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the :: picker never selected location' },
    )
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await editorText()) === PICKED_KEY, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `picking location never left ${JSON.stringify(PICKED_KEY)} in the block`,
    })

    // Read back and retype only the value: clearing the whole block would
    // drop the picked key.
    await typeVerified(
      EDITOR,
      PICKED_VALUE,
      async () => {
        const text = await editorText()
        return text.startsWith(PICKED_KEY) ? text.slice(PICKED_KEY.length) : `(no key) ${text}`
      },
      'property value',
      async () => {
        const text = await editorText()
        if (!text.startsWith(PICKED_KEY)) throw new Error(`the picked key is gone: ${text}`)
        for (let i = PICKED_KEY.length; i < text.length; i++) await browser.keys(['Backspace'])
      },
    )

    // Blur by clicking the block above, the save path a user takes most.
    await blockStaticByMarker(PICKER_SEED).click()
    await chipOf(id, `Location: ${PICKED_VALUE}`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the picked location was never stored on the block',
    })

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(PICKER_SEED).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await chipOf(id, `Location: ${PICKED_VALUE}`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the picked location did not survive the round-trip',
    })
    await expectAbsent(
      `[data-testid="block-static"]*=${PICKED_VALUE}`,
      'the picked key:: value line kept as text',
    )
  })
})
