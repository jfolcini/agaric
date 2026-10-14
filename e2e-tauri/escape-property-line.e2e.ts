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
// Two arms in one vault (a second `it` sees the first one's data). The
// CONTROL presses Escape on a blank block an Enter created and asserts the
// cleanup removed it: that is what proves the cleanup runs under this exact
// sequence (`document.hasFocus()` true in the WebView, the delete landing
// before the round-trip), so the second arm cannot pass by the cleanup never
// firing. The second arm types a `key:: value` line as the only text of a
// fresh block, presses Escape, and after a navigation round-trip asserts a
// property chip carrying the value is listed and no block holds the line as
// text.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const CONTROL_MARKER = runScopedMarker('wdio-blank-escape')
// A key no definition spells or folds to is a custom text property, which the
// backend accepts as typed. The value is the run-scoped marker.
const VALUE = runScopedMarker('wdio-escape-prop')
const LINE = `wdiokey:: ${VALUE}`
// A committed blank block renders StaticBlock's placeholder span in place of
// content (StaticBlock.tsx); a block with text never does.
const BLANK_STATIC = '[data-testid="block-static"] .block-placeholder'
// Property chips render in the block's metadata row (BlockMetadataRow), outside
// its `block-static` text, so a chip holding VALUE and no static text holding it
// is "stripped and stored".
const VALUE_CHIP = `[data-testid="property-chip"]*=${VALUE}`

describe('Agaric real-backend Escape on a property-only block (#5448)', () => {
  it('control: Escape on a blank block an Enter created cleans it up', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(CONTROL_MARKER)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // The cleanup's delete is optimistic, so the row leaves the DOM as soon as
    // the metadata probes resolve; wait for that before the round-trip, or
    // the navigation could unmount the tree under the probes.
    await expectAbsent(BLANK_STATIC, 'the blank control block')

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(CONTROL_MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(BLANK_STATIC, 'the blank control block')
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
})
