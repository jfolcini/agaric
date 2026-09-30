// ---------------------------------------------------------------------------
// Real-backend `/repeat remove` then `/repeat daily` on a limited task (#5160).
//
// `/repeat remove` deleted only `repeat`: the limit and the hidden count of
// occurrences stayed, so a rule set again on the next occurrence of a task
// limited to one was born spent, and completing it made no next occurrence.
// Removing the rule now removes both. The count is written by recurrence
// alone, so only a real completion on the real backend reaches it.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  openPageSource,
  reopenPageByTitle,
  runScopedMarker,
  setPageSource,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const TASK = runScopedMarker('wdio-repeat-readd')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const RULE = '  repeat:: daily\n  repeat-count:: 1\n'

const rowsWithTask = () => $$(`[data-testid="sortable-block"]*=${TASK}`).getElements()

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${TASK}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Wait until the page holds `count` occurrences of the task. */
async function waitForOccurrences(count: number): Promise<void> {
  await browser.waitUntil(async () => (await rowsWithTask()).length === count, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page does not hold ${count} occurrence(s) of the task`,
  })
}

/** The id of the occurrence whose task checkbox reads `state`. */
async function occurrenceIn(state: string): Promise<string> {
  let id: string | null = null
  await browser.waitUntil(
    async () => {
      for (const row of await rowsWithTask()) {
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
 * WebKit coalesces identical adjacent keys sent together.
 */
async function pickRepeatCommand(label: string): Promise<void> {
  for (const ch of '/repeat') await browser.keys([ch])
  const item = $(`[data-testid="suggestion-item"]*=${label}`)
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
}

describe('Agaric real-backend /repeat remove, then /repeat again (#5160)', () => {
  it('a rule set again after /repeat remove makes the next occurrence', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(TASK)
    await reopenTheNewPage()

    // A daily task limited to one occurrence, written as its source lines.
    const source = await openPageSource([TASK])
    const base = await source.getValue()
    await setPageSource(base.replace(`- ${TASK}`, `- [ ] ${TASK}`).replace(/\n?$/, `\n${RULE}`))
    const save = source.parentElement().$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    // Its one completion makes the next occurrence, at the limit.
    await reopenTheNewPage()
    await cycleTaskTo(await occurrenceIn('TODO'), 'DONE')
    await reopenTheNewPage()
    await waitForOccurrences(2)

    const next = await occurrenceIn('TODO')
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT REMOVE — Clear recurrence')
    await waitForToast('Repeat removed')
    await reopenTheNewPage()
    await editAtEnd(next)
    await pickRepeatCommand('REPEAT DAILY — Every day')
    await waitForToast('Set repeat to')

    await reopenTheNewPage()
    await $(`[data-block-id="${next}"] .repeat-indicator`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
    await cycleTaskTo(next, 'DONE')
    await reopenTheNewPage()
    await waitForOccurrences(3)
    expect((await rowsWithTask()).length).toBe(3)
  })
})
