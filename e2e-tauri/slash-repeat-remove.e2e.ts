// ---------------------------------------------------------------------------
// Real-backend `/repeat remove` (#5160).
//
// The slash command deletes the block's `repeat` property, and the backend
// refused it as a system-managed key: the user saw "Failed to remove repeat"
// and the task kept repeating. The mock accepted the delete, so every
// mock-backed test passed; the real backend is only in the loop here.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-repeat-remove')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The marked block's row, by the id its static render carries. */
async function markedRow() {
  const blockId = await blockStaticByMarker(MARKER).getAttribute('data-block-id')
  return $(`[data-block-id="${blockId}"]`)
}

/**
 * Type `/repeat` into the focused editor and pick `label`. A space ends the
 * slash query, so the list is filtered by `repeat` alone and the item is
 * clicked by its label.
 */
async function pickRepeatCommand(label: string): Promise<void> {
  for (const ch of '/repeat') await browser.keys([ch])
  const item = $(`[data-testid="suggestion-item"]*=${label}`)
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
}

/** The marked block's task checkbox. */
async function taskMarker() {
  const marker = (await markedRow()).$('[data-testid="task-marker"]')
  await marker.waitForExist({ timeout: NAV_TIMEOUT })
  return marker
}

/** Click the task checkbox until it reports `state`. */
async function cycleTaskTo(state: string): Promise<void> {
  const marker = await taskMarker()
  for (let click = 0; click < 5; click++) {
    const label = (await marker.getAttribute('aria-label')) ?? ''
    if (label.startsWith(`Task: ${state}.`)) return
    await marker.moveTo()
    await marker.click()
    await browser.waitUntil(async () => (await marker.getAttribute('aria-label')) !== label, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the task checkbox stayed at ${JSON.stringify(label)}`,
    })
  }
  throw new Error(`the task checkbox never reached ${state}`)
}

describe('Agaric real-backend /repeat remove (#5160)', () => {
  it('removes a task’s repeat, so completing it makes no next occurrence', async () => {
    await waitForAppReady()
    await openNewPage()
    await $(EDITOR).click()
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await typeMarkerVerified(MARKER)
    await reopenTheNewPage()
    await cycleTaskTo('TODO')
    await (await markedRow()).$('.repeat-indicator').waitForDisplayed({ timeout: NAV_TIMEOUT })

    await blockStaticByMarker(MARKER).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['End'])
    await browser.keys([' '])
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')

    // The durable read: the page re-fetched from the backend has no repeat.
    await reopenTheNewPage()
    const blockId = await blockStaticByMarker(MARKER).getAttribute('data-block-id')
    await expectAbsent(`[data-block-id="${blockId}"] .repeat-indicator`, 'the repeat indicator')

    // A repeating task would gain its next occurrence, a second row.
    await cycleTaskTo('DONE')
    await reopenTheNewPage()
    const marker = await taskMarker()
    await browser.waitUntil(
      async () => ((await marker.getAttribute('aria-label')) ?? '').startsWith('Task: DONE.'),
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the completed task did not come back DONE' },
    )
    expect((await blockStaticsByMarker(MARKER)).length).toBe(1)
  })
})
