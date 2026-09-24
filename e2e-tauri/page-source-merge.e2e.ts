// ---------------------------------------------------------------------------
// Real-backend source-mode Merge (#5140 Phase 5).
//
// A block changes through the real IPC while the page is open as its source
// buffer; the buffer edits a different block; Save meets "This page changed"
// and Merge saves the buffer with the change made elsewhere folded in. The
// re-opened page must hold both edits once each. The Playwright twin is the
// Merge case in `e2e/page-source-edit.spec.ts`, against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  navigateTo,
  openNewPage,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  setPageSource,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const FIRST = runScopedMarker('wdio-merge-first')
const SECOND = runScopedMarker('wdio-merge-second')
const THIRD = runScopedMarker('wdio-merge-third')
const MINE = runScopedMarker('wdio-merge-mine')
const ELSEWHERE = runScopedMarker('wdio-merge-elsewhere')

const rowsWith = (marker: string) => $$(`[data-testid="sortable-block"]*=${marker}`).getElements()

/** Enter moves the editor to a new, empty sibling. */
async function nextBlock(): Promise<void> {
  await browser.keys(['Enter'])
  await $('[data-testid="block-editor"] p.is-editor-empty').waitForExist({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Enter did not open an empty block',
  })
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${marker}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Another device's edit, as it lands: `edit_block` through the real IPC. */
async function editBlockElsewhere(blockId: string, toText: string): Promise<void> {
  await browser.execute(
    async (id: string, text: string) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      await internals.invoke('edit_block', { blockId: id, toText: text })
    },
    blockId,
    toText,
  )
}

describe('Agaric real-backend source-mode Merge (#5140 Phase 5)', () => {
  it('Merge saves the buffer with a change made elsewhere folded in, durably', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await nextBlock()
    await typeMarkerVerified(SECOND)
    await nextBlock()
    await typeMarkerVerified(THIRD)
    // The sidebar click blurs and commits the last block.
    await reopenTheNewPage(THIRD)
    const secondId = await $(`[data-testid="sortable-block"]*=${SECOND}`).getAttribute(
      'data-block-id',
    )
    if (secondId === null) throw new Error('the second block has no data-block-id')

    const source = await openPageSource([FIRST, SECOND, THIRD])
    const base = await source.getValue()
    await editBlockElsewhere(secondId, ELSEWHERE)
    await setPageSource(base.replace(FIRST, MINE))
    const save = source.parentElement().$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    const merge = $('[data-slot="dialog-content"]').$('button=Merge')
    await merge.waitForClickable({ timeout: ACTION_TIMEOUT })
    await merge.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Merge did not close source mode',
    })

    // A row is `sortable-block` whether it renders static or holds the editor,
    // which the re-opened page may hand to a previously focused block.
    await reopenTheNewPage(MINE)
    await browser.waitUntil(async () => (await rowsWith(ELSEWHERE)).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the edit made elsewhere once',
    })
    expect((await rowsWith(MINE)).length).toBe(1)
    expect((await rowsWith(THIRD)).length).toBe(1)
    await expectAbsent(`[data-testid="sortable-block"]*=${FIRST}`, 'the text the buffer replaced')
    await expectAbsent(`[data-testid="sortable-block"]*=${SECOND}`, 'the text replaced elsewhere')
  })
})
