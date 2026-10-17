// ---------------------------------------------------------------------------
// Real-backend: tasks in page mode (#5743).
//
// A page holding a task used to stay in block mode. Now page mode draws block
// mode's checkbox beside a task's text (`src/editor/page-mode/page-tasks.ts`),
// cycles it through `set_todo_state`, and turns a task marker left as text into
// the block's state through block mode's own commit (`commitCheckboxState`).
// This spec types `[ ] ` at the start of a block in page mode, presses
// ArrowDown, clicks the checkbox, and reads back what the real backend holds:
// the checkbox after navigating away and back, and the Agenda's task list,
// which reads the block's `todo_state` column. `e2e/page-mode.spec.ts` is the
// per-PR pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
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

const MARKER = runScopedMarker('wdio-pm-task')
const NEXT = runScopedMarker('wdio-pm-after')

/** The checkbox of the page-mode block whose id is `blockId`. */
function checkbox(blockId: string) {
  return $(`${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="task-marker"]`)
}

async function waitForState(blockId: string, state: string, when: string): Promise<void> {
  const want = `Task: ${state}. Click to cycle.`
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        const box = checkbox(blockId)
        seen = (await box.isExisting()) ? await box.getAttribute('aria-label') : null
        return seen === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the block's checkbox read ${JSON.stringify(seen)}, not ${want}`)
    })
}

describe('Agaric real-backend tasks in page mode (#5743)', () => {
  it('a typed marker and a click set the task, which stays and reaches the Agenda', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await enterBlankSibling()
    await typeMarkerVerified(NEXT)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    const at = await pageModeIndexOf(MARKER)
    const blockId = (await pageModeBlocks())[at]?.id as string
    await pageModeCaret(at, 0)
    await typeInPageMode('[ ] ', at, `[ ] ${MARKER}`)
    // Nothing yet: the caret is still in the block.
    expect(await checkbox(blockId).isExisting()).toBe(false)
    // An arrow pressed in the frame the last key is drawn in is taken back by ProseMirror's selection.
    await browser.execute(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await browser.keys(['ArrowDown'])
    await waitForState(blockId, 'TODO', 'after ArrowDown')
    await browser.waitUntil(async () => (await pageModeBlocks())[at]?.text === MARKER, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the marker stayed in the block’s text',
    })

    // The checkbox's own click: the DOM's, as layout under it may still move.
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)?.click()
    }, `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="task-marker"]`)
    await waitForState(blockId, 'DOING', 'after a click')

    // Away and back: the state is read from what the backend stored.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await $(PAGE_MODE).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await waitForState(blockId, 'DOING', 'after navigating away and back')
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([MARKER, NEXT])

    // The Agenda lists open tasks (TODO and DOING) from the backend's task column.
    await navigateTo('Journal')
    const agenda = $('button[role="tab"][aria-label="Agenda view"]')
    await agenda.waitForClickable({ timeout: NAV_TIMEOUT })
    await agenda.click()
    await browser.waitUntil(
      async () => {
        for (const row of await $$('[data-testid="agenda-results-item"]').getElements()) {
          if ((await row.getText()).includes(MARKER)) return true
        }
        return false
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: `the Agenda never listed the task ${MARKER}` },
    )
  })
})
