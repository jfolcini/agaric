// ---------------------------------------------------------------------------
// Real-backend undo of a kind change (#6156).
//
// `/h2` on a bulleted block writes the heading's text (`edit_block`) and takes
// the bullet off (`delete_property(listStyle)`), and records both in one undo
// entry by their op refs. One page-level Ctrl+Z reverts both on the backend:
// the text and the bullet come back. The mock lane checks the entry's shape;
// only here do the two reverses run on the real op log.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  editAtEnd,
  invoke,
  navigateTo,
  openNewPage,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TITLE = runScopedMarker('wdio-kind-undo-page')
const MARKER = runScopedMarker('wdio-kind-undo')

interface Kind {
  text: string
  listStyle: string | null
}

/**
 * What the backend holds of block `id`'s kind: its text, less the space typed
 * before a `/`, and its list style.
 */
async function kindOf(id: string): Promise<Kind> {
  const row = await invoke<{ content: string }>('get_block', { blockId: id })
  const props = await invoke<Array<{ key: string; value_text: string | null }>>('get_properties', {
    blockId: id,
  })
  return {
    text: row.content.trimEnd(),
    listStyle: props.find((p) => p.key === 'listStyle')?.value_text ?? null,
  }
}

/** Wait until the backend holds `want` for block `id`. */
async function expectKind(id: string, want: Kind, what: string): Promise<void> {
  let held: Kind | null = null
  try {
    await browser.waitUntil(
      async () => {
        held = await kindOf(id)
        return held.text === want.text && held.listStyle === want.listStyle
      },
      { timeout: ACTION_TIMEOUT },
    )
  } catch (error) {
    throw new Error(`${what}: the backend holds ${JSON.stringify(held)}`, { cause: error })
  }
}

describe('Agaric real-backend undo of a kind change (#6156) @editor', () => {
  it('one Ctrl+Z after /h2 on a bulleted block brings back its text and its bullet, durably', async () => {
    await waitForAppReady()
    await openNewPage(TITLE)
    await typeMarkerVerified(MARKER)
    // The sidebar click commits the text by blurring the editor.
    await navigateTo('Journal')
    await reopenPageHolding(TITLE, MARKER)
    const id = await blockStaticByMarker(MARKER).getAttribute('data-block-id')
    if (id === null) throw new Error('the block has no id')
    await invoke('set_property', {
      blockId: id,
      key: 'listStyle',
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const BULLET: Kind = { text: MARKER, listStyle: 'bullet' }
    await expectKind(id, BULLET, 'the block was never bulleted')
    // The page read again holds the style.
    await reopenPageHolding(TITLE, MARKER)
    const marker = $(
      `[data-testid="block-static"][data-block-id="${id}"] [data-testid="list-marker"]`,
    )
    await marker.waitForDisplayed({ timeout: NAV_TIMEOUT })

    await editAtEnd(id)
    // One key per call: WebKit coalesces identical adjacent keys sent together.
    for (const ch of '/h2') await browser.keys([ch])
    const item = $('[data-testid="suggestion-item"]*=Heading 2 — Medium heading')
    await item.waitForClickable({ timeout: ACTION_TIMEOUT })
    await item.click()
    await expectKind(id, { text: `## ${MARKER}`, listStyle: null }, '/h2 did not land')
    await browser.keys(['Escape'])
    // Ctrl+Z is the editor's own while a block is focused.
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await browser.keys(['Control', 'z'])
    await expectKind(id, BULLET, 'the undo did not bring back the text and the bullet')

    // The durable read: leave the page, come back, and read the backend again.
    await reopenPageHolding(TITLE, MARKER)
    await marker.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectKind(id, BULLET, 'the text and the bullet did not survive a re-open')
  })
})
