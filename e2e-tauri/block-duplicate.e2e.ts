// ---------------------------------------------------------------------------
// Real-backend Duplicate of a multi-line block (#5140 Phase 3a).
//
// Duplicate used to serialize the subtree to an indented-markdown outline and
// paste it back, and the paste split on every newline: a two-line code block
// came back as four blocks (both fences and each line). It is now one
// `duplicate_block` command that copies rows, so the copy is ONE code block
// holding both lines. The Playwright twin (`e2e/block-duplicate.spec.ts`)
// runs against the mock; this spec is the one with the real backend in it.
//
// The command copies through the Document buffer (#6190), where a bulleted
// block is a `- ` item and a task `- [ ] x`: the copy of each keeps its kind,
// which only the real render → read shows.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  enterBlankSibling,
  invoke,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const FIRST = runScopedMarker('wdio-dup-first')
const SECOND = runScopedMarker('wdio-dup-second')
const KINDS_TITLE = runScopedMarker('wdio-dup-kinds-page')
const BULLET = runScopedMarker('wdio-dup-bullet')
const TASK = runScopedMarker('wdio-dup-task')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

interface Kind {
  listStyle: string | null
  todo: string | null
}

/** The list style and task state the backend holds for block `id`. */
async function kindOf(id: string): Promise<Kind> {
  const row = await invoke<{ todo_state: string | null }>('get_block', { blockId: id })
  const props = await invoke<Array<{ key: string; value_text: string | null }>>('get_properties', {
    blockId: id,
  })
  return {
    listStyle: props.find((p) => p.key === 'listStyle')?.value_text ?? null,
    todo: row.todo_state,
  }
}

/**
 * The id of every row holding `marker`, and how many of them draw `drawn`, in
 * one read: a row resolved by one command can be gone by the next.
 */
function rowsHolding(marker: string, drawn: string): Promise<{ ids: string[]; drawn: number }> {
  return browser.execute(
    (m: string, d: string) => {
      const rows = [...document.querySelectorAll('[data-testid="sortable-block"]')].filter((row) =>
        row.textContent?.includes(m),
      )
      return {
        ids: rows.map((row) => row.getAttribute('data-block-id') ?? ''),
        drawn: rows.filter((row) => row.querySelector(d) !== null).length,
      }
    },
    marker,
    drawn,
  )
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(SECOND).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

describe('Agaric real-backend Duplicate (#5140 Phase 3a) @editor', () => {
  it('copies a two-line code block as ONE code block', async () => {
    await waitForAppReady()
    await openNewPage()

    // `/code` turns the empty first block into a code block.
    await $(EDITOR).click()
    await browser.keys('/code'.split(''))
    const codeItem = $('[data-testid="suggestion-item"]*=Insert code block')
    await codeItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await codeItem.click()
    await $('[data-testid="block-editor"] pre').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // Inside a code block Enter is a newline, not a new block. The second line
    // is paced like `typeVerified`'s retry, since its read-back covers only a
    // whole editor.
    await typeMarkerVerified(FIRST)
    await browser.keys(['Enter'])
    for (const ch of SECOND) {
      await browser.keys([ch])
      await browser.pause(40)
    }
    await browser.waitUntil(
      async () => {
        const text = await $(EDITOR).getText()
        return text.includes(FIRST) && text.includes(SECOND)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the two code lines never landed in the editor' },
    )

    // The sidebar click blurs and commits the block.
    await reopenTheNewPage()

    const original = blockStaticByMarker(SECOND)
    await original.click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'Shift', 'j'])
    // The original keeps the editor, so the copy is the only static row.
    await browser.waitUntil(async () => (await blockStaticsByMarker(SECOND)).length === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+Shift+J did not render a copy of the code block',
    })

    await reopenTheNewPage()
    // A row is `sortable-block` whether it renders static or holds the editor,
    // which the re-opened page may hand back to the original.
    const rowsHoldingSecond = () => $$(`[data-testid="sortable-block"]*=${SECOND}`).getElements()
    await browser.waitUntil(async () => (await rowsHoldingSecond()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold two copies of the code block',
    })
    // Exactly the original and ONE copy, each a single code block with both
    // lines: the old outline paste left a row per line beside them.
    const rows = await $$('[data-testid="sortable-block"]').getElements()
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const text = await row.getText()
      expect(text).toContain(FIRST)
      expect(text).toContain(SECOND)
      await expect(row.$('pre')).toBeExisting()
    }
  })

  it('copies a bulleted block bulleted and a task as a task (#6190)', async () => {
    await waitForAppReady()
    await openNewPage(KINDS_TITLE)
    await typeMarkerVerified(BULLET)
    await enterBlankSibling()
    await typeMarkerVerified(TASK)
    // The sidebar click blurs and commits the block.
    await reopenPageHolding(KINDS_TITLE, TASK)
    const bulletId = await blockStaticByMarker(BULLET).getAttribute('data-block-id')
    const taskId = await blockStaticByMarker(TASK).getAttribute('data-block-id')
    if (bulletId === null || taskId === null) throw new Error('a block has no id')
    await invoke('set_property', {
      blockId: bulletId,
      key: 'listStyle',
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await invoke('set_todo_state', { blockId: taskId, state: 'TODO' })
    await reopenPageHolding(KINDS_TITLE, TASK)

    for (const marker of [BULLET, TASK]) {
      await blockStaticByMarker(marker).click()
      await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
      await browser.keys(['Control', 'Shift', 'j'])
      // The original keeps the editor, so the copy is the only static row.
      await browser.waitUntil(async () => (await blockStaticsByMarker(marker)).length === 1, {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: `Ctrl+Shift+J did not render a copy of ${marker}`,
      })
      // Closed, so the re-opened page hands no row the editor: each draws its marker.
      await browser.keys(['Escape'])
      await $('[data-testid="block-editor"]').waitForExist({
        reverse: true,
        timeout: ACTION_TIMEOUT,
      })
    }

    await reopenPageHolding(KINDS_TITLE, TASK)
    const cases: Array<[string, string, Kind]> = [
      [BULLET, '[data-testid="list-marker"]', { listStyle: 'bullet', todo: null }],
      [TASK, '[data-testid="task-checkbox-todo"]', { listStyle: null, todo: 'TODO' }],
    ]
    for (const [marker, drawn, want] of cases) {
      let rows = { ids: [] as string[], drawn: 0 }
      await browser.waitUntil(
        async () => {
          rows = await rowsHolding(marker, drawn)
          return rows.ids.length === 2 && rows.drawn === 2
        },
        {
          timeout: NAV_TIMEOUT,
          timeoutMsg: `the re-opened page does not draw ${marker} and its copy as such`,
        },
      )
      for (const id of rows.ids) expect(await kindOf(id)).toEqual(want)
    }
  })
})
