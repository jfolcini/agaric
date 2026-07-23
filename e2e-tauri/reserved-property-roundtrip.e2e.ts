// ---------------------------------------------------------------------------
// Real-backend reserved-property (todo state) round-trip (#3085).
//
// Bug class (#3082): a reserved block property set through the UI must persist
// across a navigation round-trip against the real backend. `todo_state` is a
// reserved property written via `setTodoStateCmd` (a distinct IPC path from the
// block text edit); the JS mock and the real backend can diverge on how a
// reserved property is stored/reprojected, so only a live-backend spec guards
// it.
//
// Interaction: the per-block task checkbox is the `[data-testid="task-marker"]`
// button (BlockInlineControls.tsx `TaskMarkerButton`). Its `onClick` calls
// `onToggleTodo` -> `handleToggleTodo`, which cycles null -> 'TODO' (TASK_CYCLE
// in use-block-properties.ts) and persists via `setTodoStateCmd`. Its
// aria-label flips from `block.setTodo` ("Set as TODO") to
// `block.taskCycle` ("Task: {{state}}. Click to cycle.") once a state is set —
// giving a text signal to assert on without depending on a glyph.
//
// Selector note (load-bearing): at rest a state-less task-marker is
// `opacity-0` — but, UNLIKE the gutter controls, it has NO `pointer-events-none`
// (BlockInlineControls.tsx line ~367 vs BlockGutterControls.tsx line ~42), and
// WebDriver's displayedness algorithm ignores opacity. So the resting checkbox
// is genuinely clickable; no hover/focus dance is required. Once a state is
// set the checkbox becomes permanently visible (`[.block-active_&]` aside), so
// the post-navigation assertion is stable.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  navigateTo,
  waitForAppReady,
} from './helpers'

const MARKER = 'wdio-reserved-prop-todo'

describe('Agaric real-backend reserved-property round-trip (#3085)', () => {
  it('persists a todo state set via the task checkbox across a navigation round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // 1. Create + commit a marked block.
    await addBlockWithMarker(MARKER)

    // 2. Resolve the block's id from its StaticBlock (`data-block-id`), then
    //    scope to its ROW wrapper. SortableBlockWrapper's <li> also carries
    //    `data-block-id={block.id}` and is the ancestor of BOTH the block text
    //    and its task-marker, so `[data-block-id="<id>"]` (first match =
    //    ancestor li, in document order) contains the checkbox we want.
    const staticBlock = blockStaticByMarker(MARKER)
    await staticBlock.waitForExist({ timeout: ACTION_TIMEOUT })
    const blockId = await staticBlock.getAttribute('data-block-id')
    await expect(blockId).toBeTruthy()

    const row = $(`[data-block-id="${blockId}"]`)
    const taskMarker = row.$('[data-testid="task-marker"]')
    await taskMarker.waitForExist({ timeout: ACTION_TIMEOUT })

    // 3. Toggle the todo state (null -> TODO) and confirm it took: the button's
    //    aria-label switches to the "Task: <state>. Click to cycle." form.
    //    Hover the marker first: a state-less task-marker renders `opacity-0` at
    //    rest and only reaches `opacity-100` under the block's `group-hover`
    //    (BlockInlineControls.tsx). WebDriver can click an opacity-0 element, but
    //    moving the pointer onto it first makes it genuinely visible before the
    //    click — a cheap robustness margin for the one-shot weekly CI run.
    await taskMarker.moveTo()
    await taskMarker.click()
    await browser.waitUntil(
      async () => ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith('Task:'),
      {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: 'task-marker aria-label never reflected a set todo state',
      },
    )

    // 4. Navigate away and back — the durable-read.
    await navigateTo('Pages')
    await navigateTo('Journal')

    // 5. The block still exists AND its checkbox still reports a set todo state
    //    ("Task:") — the reserved property survived the round-trip.
    const staticAfter = blockStaticByMarker(MARKER)
    await staticAfter.waitForExist({ timeout: NAV_TIMEOUT })
    const blockIdAfter = await staticAfter.getAttribute('data-block-id')
    const rowAfter = $(`[data-block-id="${blockIdAfter}"]`)
    const taskMarkerAfter = rowAfter.$('[data-testid="task-marker"]')
    await taskMarkerAfter.waitForExist({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(
      async () => ((await taskMarkerAfter.getAttribute('aria-label')) ?? '').startsWith('Task:'),
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'todo state did not persist across the navigation round-trip',
      },
    )
  })
})
