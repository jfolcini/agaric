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
  expectAbsent,
  navigateTo,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  setPageSource,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

const rowsWith = (task: string) => $$(`[data-testid="sortable-block"]*=${task}`).getElements()

/** Create page `title` from the Pages view; it opens with its first block in the editor. */
async function openNewPageTitled(title: string): Promise<void> {
  await navigateTo('Pages')
  await typeInputVerified('#new-page-name', title)
  await browser.keys(['Enter'])
  await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/** Leave page `title` and come back, so the rows holding `task` are the backend's. */
async function reopen(title: string, task: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await blockStaticByMarker(task).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Wait until the page holds `count` occurrences of `task`. */
async function waitForOccurrences(task: string, count: number): Promise<void> {
  await browser.waitUntil(async () => (await rowsWith(task)).length === count, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page does not hold ${count} occurrence(s) of the task`,
  })
}

/** The id of the occurrence of `task` whose task checkbox reads `state`. */
async function occurrenceIn(task: string, state: string): Promise<string> {
  let id: string | null = null
  await browser.waitUntil(
    async () => {
      for (const row of await rowsWith(task)) {
        const marker = row.$('[data-testid="task-marker"]')
        if (!(await marker.isExisting())) continue
        if (((await marker.getAttribute('aria-label')) ?? '').startsWith(`Task: ${state}.`)) {
          id = await row.getAttribute('data-block-id')
          return true
        }
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `no occurrence of the task reads ${state}` },
  )
  if (id === null) throw new Error(`no occurrence of the task reads ${state}`)
  return id
}

/** Click the task checkbox of block `id` until it reports `state`. */
async function cycleTaskTo(id: string, state: string): Promise<void> {
  const marker = $(`[data-block-id="${id}"] [data-testid="task-marker"]`)
  await marker.waitForExist({ timeout: NAV_TIMEOUT })
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

/** Open block `id` in the editor, the cursor after a space at its end. */
async function editAtEnd(id: string): Promise<void> {
  await $(`[data-testid="block-static"][data-block-id="${id}"]`).click()
  await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.keys(['End'])
  await browser.keys([' '])
}

/**
 * Type `/repeat` into the focused editor and pick `label`. One key per call:
 * WebKit coalesces identical adjacent keys sent together. A space ends the
 * slash query, so the item is clicked by its label.
 */
async function pickRepeatCommand(label: string): Promise<void> {
  for (const ch of '/repeat') await browser.keys([ch])
  const item = $(`[data-testid="suggestion-item"]*=${label}`)
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
}

describe('Agaric real-backend /repeat remove (#5160)', () => {
  before(waitForAppReady)

  it('removes a task’s repeat, so completing it makes no next occurrence', async () => {
    const task = runScopedMarker('wdio-repeat-remove')
    const page = runScopedMarker('wdio-repeat-remove-page')
    await openNewPageTitled(page)
    await $(EDITOR).click()
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await typeMarkerVerified(task)
    await reopen(page, task)
    const id = await blockStaticByMarker(task).getAttribute('data-block-id')
    if (id === null) throw new Error('the task block has no id')
    await cycleTaskTo(id, 'TODO')
    await $(`[data-block-id="${id}"] .repeat-indicator`).waitForDisplayed({ timeout: NAV_TIMEOUT })

    await editAtEnd(id)
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')

    // The durable read: the page re-fetched from the backend has no repeat.
    await reopen(page, task)
    await expectAbsent(`[data-block-id="${id}"] .repeat-indicator`, 'the repeat indicator')

    // A repeating task would gain its next occurrence, a second row.
    await cycleTaskTo(id, 'DONE')
    await reopen(page, task)
    await occurrenceIn(task, 'DONE')
    expect((await rowsWith(task)).length).toBe(1)
  })

  it('a rule set again after /repeat remove makes the next occurrence', async () => {
    const task = runScopedMarker('wdio-repeat-readd')
    const page = runScopedMarker('wdio-repeat-readd-page')
    await openNewPageTitled(page)
    await typeMarkerVerified(task)
    await reopen(page, task)

    // A daily task limited to one occurrence, written as its source lines.
    const source = await openPageSource([task])
    const base = await source.getValue()
    const rule = '  repeat:: daily\n  repeat-count:: 1\n'
    await setPageSource(base.replace(`- ${task}`, `- [ ] ${task}`).replace(/\n?$/, `\n${rule}`))
    const save = source.parentElement().$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    // Its one completion makes the next occurrence, at the limit.
    await reopen(page, task)
    await cycleTaskTo(await occurrenceIn(task, 'TODO'), 'DONE')
    await reopen(page, task)
    await waitForOccurrences(task, 2)

    const next = await occurrenceIn(task, 'TODO')
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')
    await reopen(page, task)
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await waitForToast('Set repeat to')

    await reopen(page, task)
    await $(`[data-block-id="${next}"] .repeat-indicator`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
    await cycleTaskTo(next, 'DONE')
    await reopen(page, task)
    await waitForOccurrences(task, 3)
    expect((await rowsWith(task)).length).toBe(3)
  })
})
