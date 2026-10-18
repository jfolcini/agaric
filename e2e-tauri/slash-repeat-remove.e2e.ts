// ---------------------------------------------------------------------------
// Real-backend `/repeat remove` (#5160).
//
// The slash command deletes the block's `repeat` property, and the backend
// refused it as a system-managed key: the user saw "Failed to remove repeat"
// and the task kept repeating. The mock accepted the delete, so every
// mock-backed test passed; the real backend is only in the loop here.
//
// It then deleted only `repeat`: the limit and the hidden count of
// occurrences stayed, so a rule set again on the next occurrence of a task
// limited to one was born spent, and completing it made no next occurrence.
// Removing the rule now removes both. The count is written by recurrence
// alone, so only a real completion on the real backend reaches it.
//
// The two tests share one vault, so each writes its own titled page.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  cycleTaskTo,
  editAtEnd,
  expectAbsent,
  occurrenceIn,
  openPageSource,
  clickPageSourceButton,
  pageSourceLines,
  pickRepeatCommand,
  reopenPageHolding,
  runScopedMarker,
  setPageSourceLines,
  taskRows,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
  openNewPage,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** Wait until the page holds `count` occurrences of `task`. */
async function waitForOccurrences(task: string, count: number): Promise<void> {
  await browser.waitUntil(async () => (await taskRows(task)).length === count, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page does not hold ${count} occurrence(s) of the task`,
  })
}

describe('Agaric real-backend /repeat remove (#5160)', () => {
  before(waitForAppReady)

  it('removes a task’s repeat, so completing it makes no next occurrence', async () => {
    const task = runScopedMarker('wdio-repeat-remove')
    const page = runScopedMarker('wdio-repeat-remove-page')
    await openNewPage(page)
    await $(EDITOR).click()
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await typeMarkerVerified(task)
    await reopenPageHolding(page, task)
    const id = await blockStaticByMarker(task).getAttribute('data-block-id')
    if (id === null) throw new Error('the task block has no id')
    await cycleTaskTo(id, 'TODO')
    await $(`[data-block-id="${id}"] .repeat-indicator`).waitForDisplayed({ timeout: NAV_TIMEOUT })

    await editAtEnd(id)
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')

    // The durable read: the page re-fetched from the backend has no repeat.
    await reopenPageHolding(page, task)
    await expectAbsent(`[data-block-id="${id}"] .repeat-indicator`, 'the repeat indicator')

    // A repeating task would gain its next occurrence, a second row.
    await cycleTaskTo(id, 'DONE')
    await reopenPageHolding(page, task)
    await occurrenceIn(task, 'DONE')
    expect((await taskRows(task)).length).toBe(1)
  })

  it('a rule set again after /repeat remove makes the next occurrence', async () => {
    const task = runScopedMarker('wdio-repeat-readd')
    const page = runScopedMarker('wdio-repeat-readd-page')
    await openNewPage(page)
    await typeMarkerVerified(task)
    await reopenPageHolding(page, task)

    // A daily task limited to one occurrence, written as its source lines.
    const source = await openPageSource([task])
    const base = await pageSourceLines()
    const rule = '  repeat:: daily\n  repeat-count:: 1\n'
    await setPageSourceLines([
      ...base
        .filter((line) => line.text !== '')
        .map(({ text, id }) => ({ id, text: text.replace(`- ${task}`, `- [ ] ${task}`) })),
      ...rule.split('\n').map((text) => ({ text, id: null })),
    ])
    await clickPageSourceButton('Save')
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    // Its one completion makes the next occurrence, at the limit.
    await reopenPageHolding(page, task)
    await cycleTaskTo(await occurrenceIn(task, 'TODO'), 'DONE')
    await reopenPageHolding(page, task)
    await waitForOccurrences(task, 2)

    const next = await occurrenceIn(task, 'TODO')
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')
    await reopenPageHolding(page, task)
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await waitForToast('Set repeat to')

    await reopenPageHolding(page, task)
    await $(`[data-block-id="${next}"] .repeat-indicator`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
    await cycleTaskTo(next, 'DONE')
    await reopenPageHolding(page, task)
    await waitForOccurrences(task, 3)
    expect((await taskRows(task)).length).toBe(3)
  })
})
