import type { Locator, Page } from '@playwright/test'

import {
  blurEditors,
  emitMockEvent,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  openPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E — a reload of the open page keeps its block tree mounted (#6533).
 *
 * A sync, an MCP write (`blocks:changed`) and a page undo reload the open
 * page's store. The tree shows its skeleton only until the store first loads,
 * so a reload leaves every row and the focused editor in place: focus, caret
 * and selection, keys typed during and after it, the editor's own undo
 * history, the scroll position and the rows' DOM nodes all survive, and the
 * focused block saves or flushes no draft.
 *
 * The mock answers in the same tick, which hides the skeleton and the scroll
 * collapse; specs that need the reload to span frames delay
 * `load_page_subtree` test-side.
 *
 * Seed ids: src/lib/tauri-mock/seed.ts `SEED_IDS`.
 */

const SPACE = 'SPACE_PERSONAL'
const PAGE_GS = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'
const LONG_TITLE = 'Reload Long Page'
const LONG_ROWS = 150

/** What a row shows from the page's property batch, which only a property event or a reset re-reads. */
const BATCHED_ROW_STATE = [
  {
    name: 'a property chip',
    key: 'assignee',
    value: 'Ana',
    shown: (row: Locator) => row.getByText('Ana'),
  },
  {
    name: 'a list marker',
    key: 'listStyle',
    value: 'bullet',
    shown: (row: Locator) => row.getByTestId('list-marker'),
  },
]

function syncComplete(changedPageIds: string[]) {
  return {
    type: 'complete',
    remote_device_id: 'device-b',
    ops_received: 1,
    ops_sent: 0,
    changed_blocks: 1,
    changed_page_ids: changedPageIds,
  }
}

const RELOADS = [
  {
    name: 'an MCP write',
    event: 'blocks:changed',
    payload: (pageId: string) => ({ changed_page_ids: [pageId] }),
  },
  {
    name: 'a sync naming the page',
    event: 'sync:complete',
    payload: (pageId: string) => syncComplete([pageId]),
  },
  { name: 'a sync naming no page', event: 'sync:complete', payload: () => syncComplete([]) },
]

interface TreeMutations {
  skeletons: number
  rowsRemoved: number
  editorsRemoved: number
}

type SpecWindow = Window & {
  __TAURI_INTERNALS__: Record<string, unknown>
  __treeMutations__?: TreeMutations
  __scrollTops__?: number[]
  __loadsSettled__?: Record<string, number>
}

/** A page of {@link LONG_ROWS} rows, `row 1` to `row N`; resolves to the page id and the row ids. */
function seedLongPage(page: Page): Promise<{ pageId: string; rowIds: string[] }> {
  return page.evaluate(
    async ({ space, title, count }) => {
      const { invoke } = (window as unknown as SpecWindow).__TAURI_INTERNALS__ as {
        invoke: (cmd: string, args?: unknown) => Promise<unknown>
      }
      const pageId = (await invoke('create_page_in_space', {
        parentId: null,
        content: title,
        spaceId: space,
      })) as string
      const rowIds: string[] = []
      for (let i = 1; i <= count; i++) {
        const { id } = (await invoke('create_block', {
          blockType: 'content',
          content: `row ${i}`,
          parentId: pageId,
          index: null,
          scope: { kind: 'active', space_id: space },
        })) as { id: string }
        rowIds.push(id)
      }
      return { pageId, rowIds }
    },
    { space: SPACE, title: LONG_TITLE, count: LONG_ROWS },
  )
}

/**
 * Scroll the page to its bottom and wait until the rows hydrated there hold still, as rows
 * leaving the viewport turn into placeholders a few frames later; resolves to that position.
 */
async function scrollToBottom(page: Page): Promise<number> {
  const scroller = page.locator('#main-content')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const hydratedRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sortable-block"]')]
        .map((row) => row.getAttribute('data-block-id'))
        .join(),
    )
  let previous = ''
  await expect
    .poll(
      async () => {
        const now = await hydratedRows()
        const still = now === previous
        previous = now
        return still
      },
      { intervals: [250] },
    )
    .toBe(true)
  return scroller.evaluate((el) => el.scrollTop)
}

/**
 * From now on, count skeletons attached and rows or editors detached anywhere in the app, and
 * record every position the page's scroller passes through, a collapse clamping it included.
 */
async function watchTree(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = { skeletons: 0, rowsRemoved: 0, editorsRemoved: 0 }
    ;(window as unknown as SpecWindow).__treeMutations__ = seen
    const scroller = document.getElementById('main-content') as HTMLElement
    const tops = [scroller.scrollTop]
    ;(window as unknown as SpecWindow).__scrollTops__ = tops
    scroller.addEventListener('scroll', () => tops.push(scroller.scrollTop), { passive: true })
    const holds = (node: Node, selector: string) =>
      node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (holds(node, '.block-tree-loading')) seen.skeletons++
        }
        for (const node of record.removedNodes) {
          if (holds(node, '[data-testid="sortable-block"]')) seen.rowsRemoved++
          if (holds(node, '.ProseMirror')) seen.editorsRemoved++
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

function treeMutations(page: Page): Promise<TreeMutations | undefined> {
  return page.evaluate(() => (window as unknown as SpecWindow).__treeMutations__)
}

/** The distinct scroll positions seen since {@link watchTree}. */
function scrollTops(page: Page): Promise<number[]> {
  return page.evaluate(() => [...new Set((window as unknown as SpecWindow).__scrollTops__)])
}

/** Answer `load_page_subtree` `ms` later, as a busy backend does, counting the answers per page. */
async function delayPageLoads(page: Page, ms: number): Promise<void> {
  await page.evaluate((delay) => {
    const w = window as unknown as SpecWindow
    const settled: Record<string, number> = {}
    w.__loadsSettled__ = settled
    const original = w.__TAURI_INTERNALS__['invoke'] as (
      cmd: string,
      args: unknown,
      opts?: unknown,
    ) => Promise<unknown>
    w.__TAURI_INTERNALS__['invoke'] = async (cmd: string, args: unknown, opts?: unknown) => {
      const result = await original(cmd, args, opts)
      if (cmd === 'load_page_subtree') {
        await new Promise((resolve) => setTimeout(resolve, delay))
        const { rootBlockId } = args as { rootBlockId: string }
        settled[rootBlockId] = (settled[rootBlockId] ?? 0) + 1
      }
      return result
    }
  }, ms)
}

function loadsSettled(page: Page, pageId: string): Promise<number> {
  return page.evaluate(
    (id) => (window as unknown as SpecWindow).__loadsSettled__?.[id] ?? 0,
    pageId,
  )
}

/** How many times `pageId` was (re)loaded since the IPC recorder went in. */
async function pageLoads(page: Page, pageId: string): Promise<number> {
  const calls = await getInvokeCalls(page, 'load_page_subtree')
  return calls.filter((args) => args['rootBlockId'] === pageId).length
}

function selectionOf(editor: Locator): Promise<{ from: number; to: number }> {
  return editor.evaluate((el) => {
    const { from, to } = (
      el as HTMLElement & { editor: { state: { selection: { from: number; to: number } } } }
    ).editor.state.selection
    return { from, to }
  })
}

async function storedContent(page: Page, blockId: string): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
}

const UNCHANGED_TREE: TreeMutations = { skeletons: 0, rowsRemoved: 0, editorsRemoved: 0 }

test.describe('a reload of the open page keeps its editor and rows (#6533) @editor @sync @mcp', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  for (const reload of RELOADS) {
    test(`${reload.name}: keys typed during and after the reload land, and the page stays put`, async ({
      page,
    }) => {
      const { pageId, rowIds } = await seedLongPage(page)
      const lastId = rowIds.at(-1) as string
      await openPage(page, LONG_TITLE)
      await page.locator(`li[data-block-id="${lastId}"]`).scrollIntoViewIfNeeded()
      const editor = await focusBlockById(page, lastId)
      await page.keyboard.type(' one')
      await expect(editor).toHaveText(`row ${LONG_ROWS} one`)
      const bottom = await scrollToBottom(page)
      expect(bottom).toBeGreaterThan(0)
      await installIpcRecorder(page)
      await watchTree(page)
      await delayPageLoads(page, 200)

      await emitMockEvent(page, reload.event, reload.payload(pageId))
      // Four keys at 80 ms span the delayed reload: some land before it answers, some after.
      await page.keyboard.type(' two', { delay: 80 })
      await expect.poll(() => loadsSettled(page, pageId)).toBe(1)
      expect(await pageLoads(page, pageId)).toBe(1)

      await expect(editor).toBeFocused()
      await page.keyboard.type(' three')
      await expect(editor).toHaveText(`row ${LONG_ROWS} one two three`)
      expect(await treeMutations(page)).toEqual(UNCHANGED_TREE)
      expect(await scrollTops(page)).toEqual([bottom])
      await expect.poll(() => storedContent(page, lastId)).toBe(`row ${LONG_ROWS} one two three`)
    })
  }

  test('a page undo at the bottom of a long page keeps the scroll position and shows no skeleton', async ({
    page,
  }) => {
    const { pageId, rowIds } = await seedLongPage(page)
    const lastId = rowIds.at(-1) as string
    await openPage(page, LONG_TITLE)
    const last = page.locator(`li[data-block-id="${lastId}"]`)
    await last.scrollIntoViewIfNeeded()
    await focusBlockById(page, lastId)
    await page.keyboard.type(' typed')
    await blurEditors(page)
    await expect(last).toContainText(`row ${LONG_ROWS} typed`)
    const bottom = await scrollToBottom(page)
    expect(bottom).toBeGreaterThan(0)
    await watchTree(page)
    await delayPageLoads(page, 300)

    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
    await expect.poll(() => loadsSettled(page, pageId)).toBe(1)
    await expect(last).not.toContainText('typed')

    expect(await scrollTops(page)).toEqual([bottom])
    expect(await treeMutations(page)).toEqual(UNCHANGED_TREE)
  })

  test('the selection and the editor’s own undo history survive a reload', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlockById(page, GS3)
    await page.keyboard.type(' one')
    await expect(editor).toHaveText(`${GS3_TEXT} one`)
    await selectEditorRange(page, 7, 10)
    const selected = await selectionOf(editor)
    expect(selected.to - selected.from).toBe(3)
    await installIpcRecorder(page)
    await watchTree(page)

    await emitMockEvent(page, 'blocks:changed', { changed_page_ids: [PAGE_GS] })
    await expect.poll(() => pageLoads(page, PAGE_GS)).toBe(1)

    await expect(editor).toBeFocused()
    expect(await selectionOf(editor)).toEqual(selected)
    expect(await treeMutations(page)).toEqual(UNCHANGED_TREE)
    // Ctrl+Z inside the block is ProseMirror's: it takes back what was typed before the reload.
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText(GS3_TEXT)
  })

  test('a reload under a dirty editor saves and flushes no draft', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlockById(page, GS3)
    await installIpcRecorder(page)
    // Inside the draft autosave's debounce. The idle commit leaves a `key:: value` line to
    // blur, so the autosave's row is the only save of it.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('status:: kept')

    await emitMockEvent(page, 'blocks:changed', { changed_page_ids: [PAGE_GS] })
    await expect.poll(() => pageLoads(page, PAGE_GS)).toBe(1)

    expect(await getInvokeCalls(page, 'save_draft')).toEqual([])
    expect(await getInvokeCalls(page, 'flush_draft')).toEqual([])
    await expect(editor).toBeFocused()
    // The recorder does see draft traffic: the autosave's own debounce saves this one.
    await expect
      .poll(() => getInvokeCalls(page, 'save_draft'))
      .toEqual([{ blockId: GS3, content: 'status:: kept' }])
    expect(await getInvokeCalls(page, 'flush_draft')).toEqual([])
  })

  for (const state of BATCHED_ROW_STATE) {
    test(`a page undo and redo take ${state.name} off a row and back, the rows staying mounted`, async ({
      page,
    }) => {
      await openPage(page, 'Getting Started')
      const row = page.locator(`li[data-block-id="${GS3}"]`)
      await ipc(page, 'set_property', {
        blockId: GS3,
        key: state.key,
        value: {
          value_text: state.value,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
      await expect(state.shown(row)).toHaveCount(1)
      await watchTree(page)

      // An undo and a redo write properties with no property event, and the rows stay mounted:
      // each completed reload re-reads them.
      await blurEditors(page)
      await page.keyboard.press('Control+z')
      await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
      await expect(state.shown(row)).toHaveCount(0)
      await page.keyboard.press('Control+y')
      await expect(page.getByLabel('Notifications alt+T').getByText(/Red(one|id)/)).toBeVisible()
      await expect(state.shown(row)).toHaveCount(1)

      expect(await treeMutations(page)).toEqual(UNCHANGED_TREE)
    })
  }
})

test.describe('after an MCP write, Ctrl+Z undoes the agent’s op, then the user’s newest (#731) @editor @mcp', () => {
  const AGENT_TEXT = 'AGENT WROTE THIS'

  const priorityOf = async (page: Page, blockId: string): Promise<string | null> =>
    (await ipc<{ priority: string | null }>(page, 'get_block', { blockId })).priority

  // An agent's op is a page op the positional undo numbers, so `blocks:changed` re-anchors undo.
  async function agentWrites(page: Page): Promise<void> {
    await ipc(page, 'edit_block', { blockId: GS1, toText: AGENT_TEXT })
    await emitMockEvent(page, 'blocks:changed', { changed_page_ids: [PAGE_GS] })
    await expect(page.locator(`li[data-block-id="${GS1}"]`)).toContainText(AGENT_TEXT)
  }

  test.beforeEach(async ({ page }) => {
    // Edits less than `UNDO_GROUP_WINDOW_MS` apart join one undo entry; the
    // fast-forwards below keep each write an entry of its own.
    await page.clock.install()
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('the second press takes off the priority set before the write, not an older edit', async ({
    page,
  }) => {
    const gs1 = await storedContent(page, GS1)
    await focusBlockById(page, GS3)
    await page.keyboard.type(' typed')
    await blurEditors(page)
    await expect.poll(() => storedContent(page, GS3)).toBe(`${GS3_TEXT} typed`)
    await page.clock.fastForward(1000)
    await focusBlockById(page, GS2)
    await page.keyboard.press('Control+Shift+1')
    await expect.poll(() => priorityOf(page, GS2)).toBe('1')
    await blurEditors(page)
    await page.clock.fastForward(1000)
    await agentWrites(page)

    await page.keyboard.press('Control+z')
    await expect.poll(() => storedContent(page, GS1)).toBe(gs1)
    await page.keyboard.press('Control+z')
    await expect.poll(() => priorityOf(page, GS2)).toBeNull()
    expect(await storedContent(page, GS3)).toBe(`${GS3_TEXT} typed`)
  })

  test('after an undo, the press takes off the agent’s write, not the undone edit again', async ({
    page,
  }) => {
    const gs1 = await storedContent(page, GS1)
    await focusBlockById(page, GS3)
    await page.keyboard.type(' typed')
    await blurEditors(page)
    await expect.poll(() => storedContent(page, GS3)).toBe(`${GS3_TEXT} typed`)
    await page.keyboard.press('Control+z')
    await expect.poll(() => storedContent(page, GS3)).toBe(GS3_TEXT)
    await page.clock.fastForward(1000)
    await agentWrites(page)

    await page.keyboard.press('Control+z')
    await expect.poll(() => storedContent(page, GS1)).toBe(gs1)
    expect(await storedContent(page, GS3)).toBe(GS3_TEXT)
  })
})

test.describe('a reload brings the peer’s text into a focused block with nothing typed (#6533) @editor @sync', () => {
  const PEER_TEXT = `Peer: ${GS3_TEXT}`

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('a clean editor shows the peer’s text, keeps the focus, and its next key keeps the peer’s edit', async ({
    page,
  }) => {
    const editor = await focusBlockById(page, GS3)
    await ipc(page, 'edit_block', { blockId: GS3, toText: PEER_TEXT })

    await emitMockEvent(page, 'sync:complete', syncComplete([PAGE_GS]))

    await expect(editor).toHaveText(PEER_TEXT)
    await expect(editor).toBeFocused()
    await page.keyboard.type('X')
    // Wherever the caret landed, the commit is the peer's text with the key in it.
    await expect.poll(() => storedContent(page, GS3)).toContain('X')
    expect((await storedContent(page, GS3)).replace('X', '')).toBe(PEER_TEXT)
  })

  test('a dirty editor keeps what was typed through the reload', async ({ page }) => {
    const editor = await focusBlockById(page, GS3)
    await delayPageLoads(page, 0)
    // Inside the commit debounce: the typed key is not saved yet.
    await page.keyboard.type('!')
    await ipc(page, 'edit_block', { blockId: GS3, toText: PEER_TEXT })

    await emitMockEvent(page, 'sync:complete', syncComplete([PAGE_GS]))
    await expect.poll(() => loadsSettled(page, PAGE_GS)).toBe(1)

    await expect(editor).toHaveText(`${GS3_TEXT}!`)
    await expect(editor).toBeFocused()
  })
})

test.describe('a dirty editor’s save keeps the peer’s edit a reload brought (#6533) @editor @sync', () => {
  const PEER_TEXT = `Peer: ${GS3_TEXT}`

  /** Type into GS3, then have a peer's edit of its start arrive under the unsaved key. */
  async function typeThenPeerEdits(page: Page): Promise<Locator> {
    const editor = await focusBlockById(page, GS3)
    await delayPageLoads(page, 0)
    // Inside the commit debounce: the typed key is not saved yet.
    await page.keyboard.type('!')
    await ipc(page, 'edit_block', { blockId: GS3, toText: PEER_TEXT })
    await emitMockEvent(page, 'sync:complete', syncComplete([PAGE_GS]))
    await expect.poll(() => loadsSettled(page, PAGE_GS)).toBe(1)
    await expect(editor).toHaveText(`${GS3_TEXT}!`)
    return editor
  }

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('the idle commit and the keys after it save both edits', async ({ page }) => {
    const editor = await typeThenPeerEdits(page)

    await expect.poll(() => storedContent(page, GS3)).toBe(`${PEER_TEXT}!`)
    // The editor still shows its own text: the next commit starts from it.
    await expect(editor).toHaveText(`${GS3_TEXT}!`)
    await page.keyboard.type('?')
    await expect.poll(() => storedContent(page, GS3)).toBe(`${PEER_TEXT}!?`)
  })

  test('leaving the block saves both edits and shows them', async ({ page }) => {
    await typeThenPeerEdits(page)

    await blurEditors(page)

    await expect.poll(() => storedContent(page, GS3)).toBe(`${PEER_TEXT}!`)
    await expect(page.locator(`li[data-block-id="${GS3}"]`)).toContainText(`${PEER_TEXT}!`)
  })
})
