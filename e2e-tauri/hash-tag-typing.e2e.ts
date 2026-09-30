// ---------------------------------------------------------------------------
// Real-backend: typed tags are stored as the tags they name (#5160 N7).
//
// Bug class (N7, reached users): typing `#[[multi word]]` made the tag
// `[multi word` and left a stray `]` in the block, because the `[[` link rule
// fired inside the tag. This spec types both typed-tag forms, `#name` and a
// space and `#[[multi word]]` and a space, into a journal block, commits,
// navigates away and back, and reads the chips the real backend's stored
// content renders: exactly two, named as typed, and no stray bracket
// (AGENTS.md § Testing invariants, rule 4). `e2e/hash-tag-typing.spec.ts` is
// the per-PR pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-typed-tags')
// Letters, digits and `-` only, so the bare `#name` ends at the space after it.
const TAG = runScopedMarker('wdio-typed-tag')
const MULTI = runScopedMarker('wdio multi word')

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const CHIP = '[data-testid="tag-ref-chip"]'

/**
 * Type `text` one paced key at a time: WebKit drops the second of two equal
 * adjacent keys (`[[`, `]]`), see `typeMarkerVerified`.
 */
async function typePaced(text: string): Promise<void> {
  for (const ch of text) {
    await browser.keys([ch])
    await browser.pause(40)
  }
}

/** The names the tag chips under `root` show, in text order. */
async function chipNames(root: string): Promise<string[]> {
  const names: string[] = []
  for (const chip of await $(root).$$(CHIP).getElements()) names.push((await chip.getText()).trim())
  return names
}

describe('Agaric real-backend typed tags (#5160 N7)', () => {
  it('stores #name and #[[multi word]] as the tags they name, with no stray bracket', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // 1. The marker, then both typed tags; each becomes a chip on the key
    //    after it (the space), before the block is committed.
    await openJournalBlockEditor()
    await typeMarkerVerified(MARKER)
    await typePaced(` #${TAG} #[[${MULTI}]] `)
    await browser.waitUntil(async () => (await chipNames(EDITOR)).length === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the typed tags never became two chips in the editor',
    })
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // 2. Navigate away and back: the chips below are rendered from the content
    //    the real backend stored, and name the tags it holds.
    await navigateTo('Pages')
    await navigateTo('Journal')
    const block = `[data-testid="block-static"]*=${MARKER}`
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    let stored: string[] = []
    await browser
      .waitUntil(
        async () => {
          stored = await chipNames(block)
          return JSON.stringify(stored) === JSON.stringify([TAG, MULTI])
        },
        {
          timeout: NAV_TIMEOUT,
          timeoutMsg: `the stored block's tags never read ${TAG} and ${MULTI}`,
        },
      )
      .catch((err: unknown) => {
        throw new Error(`${String(err)}; last seen ${JSON.stringify(stored)}`)
      })
    expect(await $(block).getText()).not.toContain(']')
  })
})
