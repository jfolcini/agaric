// ---------------------------------------------------------------------------
// Real-backend undo of a kind change (#6156).
//
// `/h2` on a bulleted block writes the heading's text (`edit_block`) and takes
// the bullet off (`delete_property(listStyle)`), and records both in one undo
// entry by their op refs. One page-level Ctrl+Z reverts both on the backend:
// the text and the bullet come back. The mock lane checks the entry's shape;
// only here do the two reverses run on the real op log.
//
// `/bullet-list` on a task takes its state off (`set_todo_state_batch` with no
// state), and the `created_at` stamp with it, and the refs of both join the
// entry the style's write recorded. A write made after the change is the
// page's newest op, which a positional undo takes back instead of the change;
// the entry's refs leave it. Only the real backend returns the stamp's ref.
//
// The batch toolbar's TODO on two bullets is the other direction: the batch
// sets the states and stamps them, the bullets come off, and one entry holds
// the refs of both writes.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  ctrlClick,
  editAtEnd,
  invoke,
  navigateTo,
  openNewPage,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TITLE = runScopedMarker('wdio-kind-undo-page')
const MARKER = runScopedMarker('wdio-kind-undo')
const TASK_TITLE = runScopedMarker('wdio-kind-undo-task-page')
const TASK_MARKER = runScopedMarker('wdio-kind-undo-task')
const BATCH_TITLE = runScopedMarker('wdio-kind-undo-batch-page')
const BATCH_MARKERS = ['one', 'two'].map((n) => runScopedMarker(`wdio-kind-undo-batch-${n}`))

interface Kind {
  text: string
  listStyle: string | null
  /** The task state, and whether its `created_at` stamp is held: compared only where given. */
  todo?: string | null
  stamped?: boolean
}

/**
 * What the backend holds of block `id`'s kind: its text, less the space typed
 * before a `/`, its list style, and its task state with the stamp it writes.
 */
async function kindOf(id: string): Promise<Required<Kind>> {
  const row = await invoke<{ content: string; todo_state: string | null }>('get_block', {
    blockId: id,
  })
  const props = await invoke<Array<{ key: string; value_text: string | null }>>('get_properties', {
    blockId: id,
  })
  return {
    text: row.content.trimEnd(),
    listStyle: props.find((p) => p.key === 'listStyle')?.value_text ?? null,
    todo: row.todo_state,
    stamped: props.some((p) => p.key === 'created_at'),
  }
}

/** Wait until the backend holds `want` for block `id`. */
async function expectKind(id: string, want: Kind, what: string): Promise<void> {
  let held: Kind | null = null
  try {
    await browser.waitUntil(
      async () => {
        const now = await kindOf(id)
        held = now
        return (
          now.text === want.text &&
          now.listStyle === want.listStyle &&
          (want.todo === undefined || now.todo === want.todo) &&
          (want.stamped === undefined || now.stamped === want.stamped)
        )
      },
      { timeout: ACTION_TIMEOUT },
    )
  } catch (error) {
    throw new Error(`${what}: the backend holds ${JSON.stringify(held)}`, { cause: error })
  }
}

/** The write the undo of the change must leave, which landed after it. */
async function expectLaterWriteKept(id: string, what: string): Promise<void> {
  const { priority } = await invoke<{ priority: string | null }>('get_block', { blockId: id })
  if (priority !== '2') throw new Error(`${what}: the block's priority is ${String(priority)}`)
}

describe('Agaric real-backend undo of a kind change (#6156) @editor', () => {
  it('one Ctrl+Z after /h2 on a bulleted block brings back its text and its bullet, durably', async () => {
    await waitForAppReady()
    await openNewPage(TITLE)
    await typeMarkerVerified(MARKER)
    // The sidebar click commits the text by blurring the editor.
    await navigateTo('Journal')
    await reopenPageHolding(TITLE, MARKER)
    const id = await blockStaticByMarker(MARKER).getAttribute('data-block-id')
    if (id === null) throw new Error('the block has no id')
    await invoke('set_property', {
      blockId: id,
      key: 'listStyle',
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const BULLET: Kind = { text: MARKER, listStyle: 'bullet' }
    await expectKind(id, BULLET, 'the block was never bulleted')
    // The page read again holds the style.
    await reopenPageHolding(TITLE, MARKER)
    const marker = $(
      `[data-testid="block-static"][data-block-id="${id}"] [data-testid="list-marker"]`,
    )
    await marker.waitForDisplayed({ timeout: NAV_TIMEOUT })

    await editAtEnd(id)
    // One key per call: WebKit coalesces identical adjacent keys sent together.
    for (const ch of '/h2') await browser.keys([ch])
    const item = $('[data-testid="suggestion-item"]*=Heading 2 — Medium heading')
    await item.waitForClickable({ timeout: ACTION_TIMEOUT })
    await item.click()
    await expectKind(id, { text: `## ${MARKER}`, listStyle: null }, '/h2 did not land')
    await browser.keys(['Escape'])
    // Ctrl+Z is the editor's own while a block is focused.
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await browser.keys(['Control', 'z'])
    await expectKind(id, BULLET, 'the undo did not bring back the text and the bullet')

    // The durable read: leave the page, come back, and read the backend again.
    await reopenPageHolding(TITLE, MARKER)
    await marker.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectKind(id, BULLET, 'the text and the bullet did not survive a re-open')
  })

  it('one Ctrl+Z after /bullet-list on a task brings back its state and stamp, and leaves a write made after, durably', async () => {
    await openNewPage(TASK_TITLE)
    await typeMarkerVerified(TASK_MARKER)
    await navigateTo('Journal')
    await reopenPageHolding(TASK_TITLE, TASK_MARKER)
    const id = await blockStaticByMarker(TASK_MARKER).getAttribute('data-block-id')
    if (id === null) throw new Error('the block has no id')
    await invoke('set_todo_state', { blockId: id, state: 'TODO' })
    const TASK: Kind = { text: TASK_MARKER, listStyle: null, todo: 'TODO', stamped: true }
    await expectKind(id, TASK, 'the block was never made a stamped task')
    // The page read again holds the task state, which a list kind takes off.
    await reopenPageHolding(TASK_TITLE, TASK_MARKER)

    await editAtEnd(id)
    for (const ch of '/bullet') await browser.keys([ch])
    const item = $('[data-testid="suggestion-item"]*=Insert unordered list')
    await item.waitForClickable({ timeout: ACTION_TIMEOUT })
    await item.click()
    await expectKind(
      id,
      { text: TASK_MARKER, listStyle: 'bullet', todo: null, stamped: false },
      '/bullet-list did not take the task and its stamp off',
    )
    await browser.keys(['Escape'])
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await invoke('set_priority', { blockId: id, level: '2' })

    await browser.keys(['Control', 'z'])
    await expectKind(id, TASK, 'the undo did not bring back the task state and its stamp')
    await expectLaterWriteKept(id, 'the undo took back the write made after the change')

    await reopenPageHolding(TASK_TITLE, TASK_MARKER)
    await expectKind(id, TASK, 'the task state and its stamp did not survive a re-open')
    await expectLaterWriteKept(id, 'the write made after the change did not survive a re-open')
  })

  it('one Ctrl+Z after the batch toolbar made two bullets tasks brings back the bullets, and leaves a write made after, durably', async () => {
    const [first, second] = BATCH_MARKERS as [string, string]
    await openNewPage(BATCH_TITLE)
    await typeMarkerVerified(first)
    await browser.keys(['Enter'])
    await typeMarkerVerified(second)
    await navigateTo('Journal')
    await reopenPageHolding(BATCH_TITLE, second)
    const blocks: Array<{ text: string; id: string }> = []
    for (const text of BATCH_MARKERS) {
      const id = await blockStaticByMarker(text).getAttribute('data-block-id')
      if (id === null) throw new Error(`the block ${text} has no id`)
      blocks.push({ text, id })
      await invoke('set_property', {
        blockId: id,
        key: 'listStyle',
        value: {
          value_text: 'bullet',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
    }
    const prioritized = blocks[0]?.id
    if (prioritized === undefined) throw new Error('the page holds no block')
    const expectAll = async (want: Omit<Kind, 'text'>, what: string): Promise<void> => {
      for (const { text, id } of blocks) await expectKind(id, { text, ...want }, what)
    }
    const BULLET = { listStyle: 'bullet', todo: null, stamped: false }
    await expectAll(BULLET, 'the block was never bulleted')
    // The page read again holds the styles.
    await reopenPageHolding(BATCH_TITLE, second)

    for (const { text } of blocks) await ctrlClick(blockStaticByMarker(text))
    const toolbar = $('[data-testid="batch-toolbar"]')
    await browser.waitUntil(async () => (await toolbar.getText()).includes('2'), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+click did not select the two blocks',
    })
    const todo = toolbar.$('button=TODO')
    await todo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await todo.click()
    await expectAll(
      { listStyle: null, todo: 'TODO', stamped: true },
      'the batch did not make the bullet a stamped task',
    )
    await toolbar.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await invoke('set_priority', { blockId: prioritized, level: '2' })

    await browser.keys(['Control', 'z'])
    await expectAll(BULLET, 'the undo did not bring the bullet back and take the task off')
    await expectLaterWriteKept(prioritized, 'the undo took back the write made after the change')

    await reopenPageHolding(BATCH_TITLE, second)
    await expectAll(BULLET, 'the bullet did not survive a re-open')
    await expectLaterWriteKept(
      prioritized,
      'the write made after the change did not survive a re-open',
    )
  })
})
