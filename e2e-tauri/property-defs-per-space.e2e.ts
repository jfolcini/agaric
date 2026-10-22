// ---------------------------------------------------------------------------
// Real-backend: property definitions are per space (#5841 S0.5).
//
// `wdiosize` is declared `number` in Personal and `text` in Work, through the
// real IPC (the setup is not under test). The same `wdiosize:: <value>` line,
// typed as a block's only text and blurred with Escape, is then read by each
// space's own definition (`commitInlineProperties` asks for the active space's,
// and the backend checks the block's space): Work's `text` stores it as a
// property chip; Personal's `number` refuses the text, which stays in the block
// with a "Kept as text" toast. After a navigation round-trip each block still
// shows what its own space's type made of it, from the stored rows.
//
// The two arms are each other's control: the Work arm shows the line is read
// and stored when the type admits it, so the Personal arm's text cannot be a
// parser that never ran.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  invoke,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  switchToSpace,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const KEY = 'wdiosize'
const IN_WORK = runScopedMarker('wdio-size-work')
const IN_PERSONAL = runScopedMarker('wdio-size-personal')

/** A property chip carrying `value`: chips render outside the block's static text. */
const chipWith = (value: string) => `[data-testid="property-chip"]*=${value}`

/** Type `KEY:: value` as a fresh journal block's only text and blur it with Escape. */
async function typeLineAndEscape(value: string): Promise<void> {
  await navigateTo('Journal')
  await openJournalBlockEditor()
  await typeMarkerVerified(`${KEY}:: ${value}`)
  await browser.keys(['Escape'])
}

/** Leave the journal through the sidebar and come back. */
async function roundTrip(): Promise<void> {
  await navigateTo('Pages')
  await navigateTo('Journal')
}

describe('Agaric real-backend per-space property definitions (#5841) @editor @spaces', () => {
  it('reads one key by each space’s own type, before and after a round-trip', async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const idOf = (name: string) => {
      const space = spaces.find((s) => s.name === name)
      if (space === undefined) throw new Error(`no ${name} space`)
      return space.id
    }
    for (const [name, valueType] of [
      ['Personal', 'number'],
      ['Work', 'text'],
    ] as const) {
      await invoke('create_property_def', {
        spaceId: idOf(name),
        key: KEY,
        valueType,
        options: null,
      })
    }

    // Work: `text` admits the value, so the line becomes a chip.
    await switchToSpace('Work')
    await typeLineAndEscape(IN_WORK)
    await $(chipWith(IN_WORK)).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // Personal: `number` refuses it, so the line stays text.
    await switchToSpace('Personal')
    await typeLineAndEscape(IN_PERSONAL)
    await waitForToast(`Kept as text: ${KEY}:: ${IN_PERSONAL}`)
    await blockStaticByMarker(IN_PERSONAL).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await roundTrip()
    await blockStaticByMarker(IN_PERSONAL).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(chipWith(IN_PERSONAL), 'a Personal chip for the refused value')

    await switchToSpace('Work')
    await roundTrip()
    await $(chipWith(IN_WORK)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`[data-testid="block-static"]*=${IN_WORK}`, 'the Work line kept as text')
  })
})
