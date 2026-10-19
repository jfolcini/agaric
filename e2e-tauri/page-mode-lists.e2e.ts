// ---------------------------------------------------------------------------
// Real-backend: bullet and numbered blocks in page mode (#5743).
//
// A page holding a bullet or numbered block used to stay in block mode. Now
// page mode draws block mode's list marker beside a block's text
// (`src/editor/page-mode/page-lists.ts`), and its keys are block mode's: `1. `
// typed at a block's start makes it numbered, Enter continues the list, and
// Enter on an empty item leaves it. Each style is a `listStyle` property,
// written through `set_property` / `delete_property` after the save. This spec
// makes a bullet through the real IPC, opens the page in page mode, presses
// Enter after it and types `1. first`, Enter, `second`, Enter and Enter again,
// then reads the stored styles back, after navigating away and back.
// `e2e/page-mode.spec.ts` is the per-PR pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const ITEM = runScopedMarker('wdio-pm-list')

interface PropertyRow {
  key: string
  value_text: string | null
}

/** Block `blockId`'s stored list style, or null. */
async function listStyle(blockId: string): Promise<string | null> {
  const rows = await invoke<PropertyRow[]>('get_properties', { blockId })
  return rows.find((row) => row.key === 'listStyle')?.value_text ?? null
}

/** Each page-mode block's marker, in order: '' for none. */
function markers(): Promise<string[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(`${selector} [data-page-block]`)].map(
        (el) => el.querySelector(':scope > [data-testid="list-marker"]')?.textContent ?? '',
      ),
    PAGE_MODE,
  )
}

async function waitForMarkers(want: string[], when: string): Promise<void> {
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await markers()
        return JSON.stringify(seen) === JSON.stringify(want)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `${when}, the markers read ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`,
      )
    })
}

async function pressEnter(count: number): Promise<void> {
  await browser.keys(['Enter'])
  await browser.waitUntil(async () => (await pageModeBlocks()).length === count, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `Enter did not leave the page at ${count} blocks`,
  })
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await chooseEditMode('Page')
}

describe('Agaric real-backend lists in page mode (#5743) @editor @pages', () => {
  it('a bullet opens in page mode; `1. `, Enter and Enter again make and leave a numbered list, and the styles stay', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(ITEM)
    await reopenInPageMode()
    const itemId = (await pageModeBlocks())[await pageModeIndexOf(ITEM)]?.id as string

    // A bullet set elsewhere keeps nothing out: Page opens with its marker.
    await invoke('set_property', {
      blockId: itemId,
      key: 'listStyle',
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await reopenInPageMode()
    await waitForMarkers(['•'], 'on opening')

    // Enter continues the bullet; `1. ` at the new block's start makes it numbered.
    await pageModeCaret(0, 'end')
    await pressEnter(2)
    await waitForMarkers(['•', '•'], 'after Enter on the bullet')
    await typeInPageMode('1. first', 1, 'first')
    await pressEnter(3)
    await typeInPageMode('second', 2, 'second')
    await waitForMarkers(['•', '1.', '2.'], 'after typing the numbered list')
    await pressEnter(4)
    await waitForMarkers(['•', '1.', '2.', '3.'], 'after Enter on the second item')
    // Enter on the empty third item leaves the list instead of making a fourth.
    await browser.keys(['Enter'])
    await waitForMarkers(['•', '1.', '2.', ''], 'after Enter on the empty item')
    await typeInPageMode('after', 3, 'after')
    expect((await pageModeBlocks()).length).toBe(4)

    const ids = (await pageModeBlocks()).map((block) => block.id)
    let stored: Array<string | null> = []
    await browser
      .waitUntil(
        async () => {
          stored = await Promise.all(ids.map(listStyle))
          return JSON.stringify(stored) === JSON.stringify(['bullet', 'ordered', 'ordered', null])
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the stored list styles read ${JSON.stringify(stored)}`)
      })

    // Away and back: the page reopens as *Edit pages as* says, so Page is chosen again.
    await reopenInPageMode()
    await waitForMarkers(['•', '1.', '2.', ''], 'after navigating away and back')
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([
      ITEM,
      'first',
      'second',
      'after',
    ])
    expect(await Promise.all(ids.map(listStyle))).toEqual(['bullet', 'ordered', 'ordered', null])
  })
})
