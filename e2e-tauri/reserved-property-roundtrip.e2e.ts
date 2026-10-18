// ---------------------------------------------------------------------------
// Real-backend block-property round-trips: a reserved property (todo state,
// #3085) and a ref property added from the block's property drawer (#5862).
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
// A ref property added from the drawer used to send `set_property` with every
// value field null, which the backend refuses (`validate_set_property`), so
// the add failed. Add now opens a draft row whose page picker writes the ref
// (#5862). Only this lane holds the backend that refused the add; the chip's
// live title is pinned on the mock lane (`e2e/property-ref-boolean-chips.spec.ts`).
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  chooseSelectOption,
  navigateTo,
  openPropertyDrawer,
  openNewPage,
  openSettingsTab,
  reopenPageByTitle,
  reopenPageHolding,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

// #3334 — scoped to this run, so the durable read cannot resolve a previous
// run's leftover row (which would carry its own already-set todo state).
const MARKER = runScopedMarker('wdio-reserved-prop-todo')

const REF_KEY = runScopedMarker('wdio-ref-owner')
const REF_HOME = runScopedMarker('wdio-ref-home')
const REF_BLOCK = runScopedMarker('wdio-ref-block')
const REF_TARGET = runScopedMarker('wdio-ref-target')

const DRAWER = '[role="dialog"]*=Block Properties'

/** Block `id`'s row, static or holding the editor (coming back to a page can refocus its block). */
const blockRow = (id: string) => $(`[data-testid="sortable-block"][data-block-id="${id}"]`)

/** Close the open property drawer with its Close button. */
async function closePropertyDrawer(): Promise<void> {
  const close = $(DRAWER).$('[data-slot="sheet-close"]')
  await close.waitForClickable({ timeout: ACTION_TIMEOUT })
  await close.click()
  await $(DRAWER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/** The drawer row's page picker for `key` (`pageProperty.valueLabel`), which shows the ref's title. */
const refPicker = (key: string) => $(`button[aria-label="${key} value"]`)

/** Wait until the drawer's picker for `key` shows `title`. */
async function expectPickerShows(key: string, title: string): Promise<void> {
  await browser.waitUntil(async () => (await refPicker(key).getText()) === title, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the drawer's ${key} row never showed ${title}`,
  })
}

/** The ref chip on block `id` that opens `title` (`property.openRefTarget`). */
const refChip = (id: string, title: string) =>
  blockRow(id).$(`[data-testid="property-chip"] button[aria-label="Open ${title}"]`)

describe('Agaric real-backend block-property round-trips (#3085, #5862) @editor', () => {
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
    // Not awaited: `toBeTruthy` on a plain string is expect's SYNCHRONOUS
    // matcher (only the element matchers — `toBeDisplayed` &c. — are async).
    expect(blockId).toBeTruthy()

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

  it('adds a ref property from the drawer and keeps it across a navigation round-trip', async () => {
    await waitForAppReady()

    // 1. Define the ref key in Settings › Properties; the drawer offers only defined keys.
    await openSettingsTab('properties')
    const panel = '[data-testid="settings-panel-properties"]'
    await typeInputVerified(`${panel} input[aria-label="Property key"]`, REF_KEY)
    await chooseSelectOption(`${panel} [aria-label="Type"]`, 'ref')
    const create = $(panel).$('button*=Create')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()
    await waitForToast('Property definition created')

    // 2. The page the ref will point at, and a page holding the block that carries it.
    await openNewPage(REF_TARGET)
    await openNewPage(REF_HOME)
    await typeMarkerVerified(REF_BLOCK)
    await reopenPageHolding(REF_HOME, REF_BLOCK)
    const blockId = await blockStaticByMarker(REF_BLOCK).getAttribute('data-block-id')
    if (blockId === null) throw new Error(`the block ${REF_BLOCK} has no data-block-id`)

    // 3. Add the key from the drawer, then pick the target in its row's page picker.
    await openPropertyDrawer(blockId)
    const add = $(DRAWER).$('button[aria-label="Add property"]')
    await add.waitForClickable({ timeout: ACTION_TIMEOUT })
    await add.click()
    await typeInputVerified('input[aria-label="Search definitions"]', REF_KEY)
    // The picker lists a key as `formatPropertyName` spells it.
    const label = REF_KEY.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    const def = $(`.//button[span[normalize-space(.)="${label}"]]`)
    await def.waitForClickable({ timeout: ACTION_TIMEOUT })
    await def.click()
    await refPicker(REF_KEY).waitForClickable({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `adding ${REF_KEY} opened no row with a page picker`,
    })
    await refPicker(REF_KEY).click()
    const page = $('[aria-label="Select a page"]').$(
      `.//button[span[normalize-space(.)="${REF_TARGET}"]]`,
    )
    await page.waitForClickable({ timeout: ACTION_TIMEOUT })
    await page.click()
    await expectPickerShows(REF_KEY, REF_TARGET)
    await closePropertyDrawer()

    // 4. Leave and come back: the chip and the drawer row read the stored ref.
    await reopenPageByTitle(REF_HOME)
    await refChip(blockId, REF_TARGET).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `block ${blockId} shows no ${REF_KEY} chip opening ${REF_TARGET} after the round-trip`,
    })
    await openPropertyDrawer(blockId)
    await expectPickerShows(REF_KEY, REF_TARGET)
    await closePropertyDrawer()
  })
})
