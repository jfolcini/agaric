// ---------------------------------------------------------------------------
// Real-backend Duplicate of a repeating task (#5160 P4).
//
// Duplicate renders the block as the page's source buffer and reads it back.
// That buffer used to leave the recurrence rule out, so the copy of a weekly
// task was a task that did not repeat. It now writes and reads `repeat::`
// lines, so the copy repeats. The mock copies rows without the buffer, so only
// this lane runs the render → read the real command goes through.
//
// The task is made repeating through "Edit as Markdown", which reads the same
// `repeat::` line, and the copy is checked twice after a navigation
// round-trip: its repeat chip (BlockInlineControls.tsx) and its own
// `repeat:: +1w` line in the page's source.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  navigateTo,
  openNewPage,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  setPageSource,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK = runScopedMarker('wdio-dup-repeat')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const RULE = '  repeat:: +1w\n'

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${TASK}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Save the open source buffer and wait for the block tree to come back. */
async function saveSource(source: ReturnType<typeof $>): Promise<void> {
  const save = source.parentElement().$('button=Save')
  await save.waitForClickable({ timeout: ACTION_TIMEOUT })
  await save.click()
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })
}

describe('Agaric real-backend Duplicate of a repeating task (#5160 P4)', () => {
  it('the copy of a weekly task repeats weekly', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(TASK)
    // The sidebar click blurs and commits the block.
    await reopenTheNewPage()

    // Make it a task that repeats weekly: a checkbox and a `repeat::` line.
    const source = await openPageSource([TASK])
    const base = await source.getValue()
    await setPageSource(base.replace(`- ${TASK}`, `- [ ] ${TASK}`).replace(/\n?$/, `\n${RULE}`))
    await saveSource(source)
    await reopenTheNewPage()
    const rowsWithTask = () => $$(`[data-testid="sortable-block"]*=${TASK}`).getElements()
    const chips = async () => {
      let count = 0
      for (const row of await rowsWithTask()) {
        if (await row.$('.repeat-indicator').isExisting()) count += 1
      }
      return count
    }
    await browser.waitUntil(async () => (await chips()) === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the task never showed its repeat chip',
    })

    const original = blockStaticByMarker(TASK)
    await original.click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'Shift', 'j'])
    // The original keeps the editor, so the copy is the only static row.
    await browser.waitUntil(async () => (await blockStaticsByMarker(TASK)).length === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+Shift+J did not render a copy of the task',
    })

    await reopenTheNewPage()
    await browser.waitUntil(async () => (await rowsWithTask()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the task and its copy',
    })
    await browser.waitUntil(async () => (await chips()) === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the copy does not show a repeat chip',
    })
    const saved = await (await openPageSource([TASK])).getValue()
    expect(saved.split(RULE).length - 1).toBe(2)
  })
})
