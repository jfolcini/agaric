// ---------------------------------------------------------------------------
// Real-backend: attachments in page mode (#5743).
//
// A page holding an attachment used to stay in block mode. Now page mode reads
// the page's attachments with its properties (`readPageFit`) and draws block
// mode's previews and attachment badge under a block's text
// (`src/editor/page-mode/PageBlockMetadata.tsx`). This spec gives one block a
// task, another a property and a text attachment, through the real IPC, opens
// the page in page mode, toggles the task with its checkbox, and reads back
// what the backend holds after navigating away and back: the attachment's
// bytes from the app data dir, which the mock never holds. `e2e/page-mode.spec.ts`
// is the per-PR pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import { PAGE_MODE, chooseEditMode, pageModeBlocks, pageModeIndexOf } from './page-mode'

const TASK = runScopedMarker('wdio-pm-attach-task')
const NOTE = runScopedMarker('wdio-pm-attach-note')
const PREVIEW = 'notes from the real backend'

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

/** Call the real backend as another surface does. */
function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c: string, a: Record<string, unknown>) =>
      (window as unknown as Internals).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>
}

/** The `textContent` of what `selector` matches inside block `blockId`, or null. */
function textIn(blockId: string, selector: string): Promise<string | null> {
  return browser.execute(
    (css: string) => document.querySelector(css)?.textContent ?? null,
    `${PAGE_MODE} [data-page-block-id="${blockId}"] ${selector}`,
  )
}

/** The `aria-label` of what `selector` matches inside block `blockId`, or null. */
function labelIn(blockId: string, selector: string): Promise<string | null> {
  return browser.execute(
    (css: string) => document.querySelector(css)?.getAttribute('aria-label') ?? null,
    `${PAGE_MODE} [data-page-block-id="${blockId}"] ${selector}`,
  )
}

async function waitFor(read: () => Promise<string | null>, want: string, when: string) {
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        seen = await read()
        return seen === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, read ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`)
    })
}

async function waitForShown(taskId: string, noteId: string, state: string, when: string) {
  await waitFor(
    () => labelIn(taskId, '[data-testid="task-marker"]'),
    `Task: ${state}. Click to cycle.`,
    when,
  )
  await waitFor(() => labelIn(noteId, '[data-testid="property-chip"]'), 'Assignee: Ana', when)
  await waitFor(() => labelIn(noteId, '[data-testid="attachment-badge"]'), '1 attachment', when)
  await waitFor(() => textIn(noteId, '[data-testid="markdown-attachment-body"]'), PREVIEW, when)
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await chooseEditMode('Page')
}

describe('Agaric real-backend attachments in page mode (#5743) @editor @pages @attachments', () => {
  it('a page with a task, a property and an attachment opens in page mode, and a toggled task stays', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(TASK)
    await enterBlankSibling()
    await typeMarkerVerified(NOTE)
    await reopenInPageMode()
    const blocks = await pageModeBlocks()
    const taskId = blocks[await pageModeIndexOf(TASK)]?.id as string
    const noteId = blocks[await pageModeIndexOf(NOTE)]?.id as string

    // Set elsewhere: none of them keeps the page out of page mode.
    await invoke('set_todo_state', { blockId: taskId, state: 'TODO' })
    await invoke('set_property', {
      blockId: noteId,
      key: 'assignee',
      value: {
        value_text: 'Ana',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await invoke('add_attachment_with_bytes', {
      blockId: noteId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [...new TextEncoder().encode(PREVIEW)],
    })
    await reopenInPageMode()
    await waitForShown(taskId, noteId, 'TODO', 'on opening')

    // The checkbox's own click: the DOM's, as layout under it may still move.
    await browser.execute((css: string) => {
      document.querySelector<HTMLElement>(css)?.click()
    }, `${PAGE_MODE} [data-page-block-id="${taskId}"] [data-testid="task-marker"]`)
    await waitFor(
      () => labelIn(taskId, '[data-testid="task-marker"]'),
      'Task: DOING. Click to cycle.',
      'after the click',
    )

    // Away and back: everything is read again from what the backend stored.
    await reopenInPageMode()
    await waitForShown(taskId, noteId, 'DOING', 'after navigating away and back')
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([TASK, NOTE])
    const stored = await invoke<{ todo_state: string | null }>('get_block', { blockId: taskId })
    expect(stored.todo_state).toBe('DOING')
    const files = await invoke<Array<{ filename: string }>>('list_attachments', { blockId: noteId })
    expect(files.map((file) => file.filename)).toEqual(['notes.txt'])
  })
})
