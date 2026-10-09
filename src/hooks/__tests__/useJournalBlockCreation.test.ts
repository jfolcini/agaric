/**
 * Tests for useJournalBlockCreation hook.
 *
 * Validates:
 *  - Creates a page via createPageInSpace and defers seed-block creation
 * To BlockTree's autoCreateFirstBlock effect when no template
 *    is configured for the active space
 *  - Skips page creation when an entry already exists in pageMap
 *  - Skips page creation when an entry already exists in createdPages (local)
 *  - Renders the day the backend created, journal template included
 *    (#5395), and focuses its first block without inserting the template
 *    a second time
 *  - Surfaces a toast on errors and bails out gracefully
 *  - Refuses to create a page without an active space
 *
 * The no-template branch no longer calls `createBlock` itself.
 * `BlockTree.autoCreateFirstBlock` is the single owner of seed-block
 * creation on a fresh daily page; firing a second `createBlock` here used
 * to race that effect and produce two blocks for the same page.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { useJournalBlockCreation } from '@/hooks/useJournalBlockCreation'
import { unwrap } from '@/lib/app-error'
import type { WithOps } from '@/lib/bindings'
import type { BlockRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { createBlock } from '@/lib/ipc-helpers'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import {
  _resetPrefetchPageSubtreeForTest,
  consumePrefetchedPageSubtree,
} from '@/lib/prefetch-page-subtree'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/** `create_block` answers with the row inside the `op_refs` envelope. */
function createdBlock(parentId: string, position: number): WithOps<BlockRow> {
  return withOps(makeBlockRow({ id: 'B1', content: '', parent_id: parentId, position }))
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetPrefetchPageSubtreeForTest()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
    selectionAnchorId: null,
    selectionFocusId: null,
  })
})

interface PageCreatedCall {
  dateStr: string
  pageId: string
}

interface SetupResult {
  result: { current: ReturnType<typeof useJournalBlockCreation> }
  rerender: (props: {
    pageMap: Map<string, string>
    onPageCreated: (dateStr: string, pageId: string) => void
  }) => void
  pageCreatedCalls: PageCreatedCall[]
  unmount: () => void
}

function setup(initialPageMap = new Map<string, string>()): SetupResult {
  const pageCreatedCalls: PageCreatedCall[] = []
  const onPageCreated = (dateStr: string, pageId: string) => {
    pageCreatedCalls.push({ dateStr, pageId })
  }
  const rendered = renderHook(
    ({ pageMap, onPageCreated: cb }) => useJournalBlockCreation({ pageMap, onPageCreated: cb }),
    { initialProps: { pageMap: initialPageMap, onPageCreated } },
  )
  return {
    result: rendered.result,
    rerender: rendered.rerender,
    pageCreatedCalls,
    unmount: rendered.unmount,
  }
}

describe('useJournalBlockCreation', () => {
  it('creates a page and defers seed-block creation when no template is configured', async () => {
    // When no journal template is configured for the active
    // space, the hook MUST NOT call `create_block` for the fresh page.
    // `BlockTree.autoCreateFirstBlock` is the single owner of that
    // seed-block create; calling it here too raced and produced two
    // blocks for the same page.
    stubInvoke({ create_page_in_space: () => 'PNEW', first_child_for_blocks: () => ({}) })

    const { result, pageCreatedCalls } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    // Page was created for the date with the active space
    expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
      parentId: null,
      content: '2025-06-15',
      spaceId: 'SPACE_TEST',
    })
    // NO `create_block` IPC: BlockTree owns seed-block creation
    const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createBlockCalls).toHaveLength(0)
    // onPageCreated callback fired AFTER the template branch resolved —
    // See `useJournalBlockCreation.ts` ordering note. The
    // observable contract for the caller (a single notification with the
    // new page id) is unchanged.
    expect(pageCreatedCalls).toEqual([{ dateStr: '2025-06-15', pageId: 'PNEW' }])
    // createdPages map updated
    expect(result.current.createdPages.get('2025-06-15')).toBe('PNEW')
  })

  it('parks an empty subtree for a day the backend left empty, so its first load skips the IPC (#5438)', async () => {
    stubInvoke({ create_page_in_space: () => 'PNEW', first_child_for_blocks: () => ({}) })

    const { result } = setup()
    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    await expect(consumePrefetchedPageSubtree('SPACE_TEST', 'PNEW')).resolves.toEqual({
      blocks: [],
      truncated: false,
      total: 0,
    })
  })

  it('parks nothing when the backend seeded the day from its template (#5438)', async () => {
    stubInvoke({
      create_page_in_space: () => 'PNEW',
      first_child_for_blocks: () => ({ PNEW: makeBlockRow({ id: 'T1', parent_id: 'PNEW' }) }),
    })

    const { result } = setup()
    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(consumePrefetchedPageSubtree('SPACE_TEST', 'PNEW')).toBeNull()
    expect(useBlockStore.getState().focusedBlockId).toBe('T1')
  })

  it('parks nothing when the first-child probe fails, so a seeded day is never read as empty (#5438)', async () => {
    stubInvoke({
      create_page_in_space: () => 'PNEW',
      first_child_for_blocks: () => Promise.reject(new Error('probe boom')),
    })

    const { result } = setup()
    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(consumePrefetchedPageSubtree('SPACE_TEST', 'PNEW')).toBeNull()
    expect(result.current.createdPages.get('2025-06-15')).toBe('PNEW')
  })

  // #4358 / #4338 — this hook creates a date page in exactly the way the
  // date picker's `handleDateMode` does, but it never calls
  // `useBlockResolve()`, so it cannot use `registerCreatedPage`. Before the
  // bus emission it did not reach the picker's cache at all: a journal day
  // the user is looking at was unfindable by the name it displays.
  it("publishes an 'added' event for the date page it creates", async () => {
    stubInvoke({ create_page_in_space: () => 'PNEW', first_child_for_blocks: () => ({}) })

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const { result } = setup()
      await act(async () => {
        await result.current.handleAddBlock('2025-06-15')
      })
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      { kind: 'added', entity: 'page', id: 'PNEW', name: '2025-06-15', spaceId: 'SPACE_TEST' },
    ])
  })

  it('publishes nothing when the day already has a page', async () => {
    // The existing-page path still seeds a block; the previous literal stub
    // left it unmodelled, so it resolved `null` off a leaked catch-all.
    stubInvoke({ create_block: () => createdBlock('PEXIST', 1) })

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const { result } = setup(new Map([['2025-06-15', 'PEXIST']]))
      await act(async () => {
        await result.current.handleAddBlock('2025-06-15')
      })
    } finally {
      unsubscribe()
    }

    // No page came into existence, so nothing to announce — and a spurious
    // event would bump every picker's generation and abort in-flight fills.
    expect(changes).toEqual([])
  })

  it('does not create a new page when one already exists in pageMap', async () => {
    stubInvoke({ create_block: () => createdBlock('PEXIST', 1) })

    const { result, pageCreatedCalls } = setup(new Map([['2025-06-15', 'PEXIST']]))

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    // No create_page_in_space call
    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    )
    expect(createPageCalls).toHaveLength(0)

    // create_block under the existing page
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'PEXIST',
      index: null,
      scope: { kind: 'global' },
      // #2849 PR2 — direct createBlock supplies no client id (null).
      blockId: null,
    })
    expect(pageCreatedCalls).toHaveLength(0)
  })

  it('does not call createBlock when no template is configured', async () => {
    // Explicit regression: when the space has no journal template, the
    // hook must not call `create_block`. Seed-block creation is delegated to
    // `BlockTree.autoCreateFirstBlock`, which observes the empty page
    // when DaySection mounts BlockTree after `setCreatedPages` fires.
    stubInvoke({ create_page_in_space: () => 'PNEW', first_child_for_blocks: () => ({}) })

    const { result, pageCreatedCalls } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    // Page was created
    expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
      parentId: null,
      content: '2025-06-15',
      spaceId: 'SPACE_TEST',
    })
    // No `create_block` IPC fired by the hook in the no-template branch
    const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createBlockCalls).toHaveLength(0)
    // Page-render notification still fires so DaySection can mount BlockTree
    expect(pageCreatedCalls).toEqual([{ dateStr: '2025-06-15', pageId: 'PNEW' }])
  })

  it('shows a toast and bails when there is no active space', async () => {
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
    // No page was created
    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    )
    expect(createPageCalls).toHaveLength(0)
  })

  it('shows a toast when create_page_in_space rejects', async () => {
    stubInvoke({ create_page_in_space: () => Promise.reject(new Error('backend down')) })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })
  })

  // #5395 — the probe only decides the caret; the day it cannot read still
  // renders, and no error toast blames a page that was created.
  it('renders the day and focuses nothing when the first-child probe rejects', async () => {
    stubInvoke({
      create_page_in_space: () => 'PNEW',
      first_child_for_blocks: () => Promise.reject(new Error('backend down')),
    })

    const { result, pageCreatedCalls } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(result.current.createdPages.get('2025-06-15')).toBe('PNEW')
    expect(pageCreatedCalls).toEqual([{ dateStr: '2025-06-15', pageId: 'PNEW' }])
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('does not re-create a page once it exists in createdPages (idempotent)', async () => {
    stubInvoke({
      create_page_in_space: () => 'PNEW',
      first_child_for_blocks: () => ({}),
      create_block: () => createdBlock('PNEW', 0),
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const createPageCallsAfterFirst = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    ).length
    expect(createPageCallsAfterFirst).toBe(1)

    // Second call to handleAddBlock for the same date — page already in createdPages
    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const createPageCallsAfterSecond = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    ).length
    expect(createPageCallsAfterSecond).toBe(1)
  })

  // #2543 — `createdPages` is only updated AFTER the whole page-create +
  // template-load sequence settles, so (unlike the previous test, which
  // covers the ALREADY-created case) a genuine double-click BEFORE the
  // first invocation resolves used to see `createdPages`/`pageMap` both
  // empty on both calls and durably create two journal pages for the
  // same date.
  it('does not fire two create_page_in_space IPCs on a double-click before the first resolves', async () => {
    const resolvers: Array<(v: string) => void> = []
    stubInvoke({
      create_page_in_space: () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        }),
      first_child_for_blocks: () => ({}),
    })

    const { result } = setup()

    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => {
      p1 = result.current.handleAddBlock('2025-06-15')
      p2 = result.current.handleAddBlock('2025-06-15')
    })

    // The in-flight guard must bail the second call before it ever
    // reaches the IPC — only one create_page_in_space request in flight.
    expect(resolvers).toHaveLength(1)

    await act(async () => {
      resolvers[0]?.('PNEW')
      await Promise.all([p1, p2])
    })

    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    )
    expect(createPageCalls).toHaveLength(1)
  })

  it('does not fire two create_block IPCs on a double-click before the first resolves (existing page)', async () => {
    const resolvers: Array<(v: WithOps<BlockRow>) => void> = []
    stubInvoke({
      create_block: () =>
        new Promise<WithOps<BlockRow>>((resolve) => {
          resolvers.push(resolve)
        }),
    })

    const { result } = setup(new Map([['2025-06-15', 'PEXIST']]))

    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => {
      p1 = result.current.handleAddBlock('2025-06-15')
      p2 = result.current.handleAddBlock('2025-06-15')
    })

    expect(resolvers).toHaveLength(1)

    await act(async () => {
      resolvers[0]?.(createdBlock('PEXIST', 1))
      await Promise.all([p1, p2])
    })

    const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createBlockCalls).toHaveLength(1)
  })

  // #2543 — the hook set focus via a raw `useBlockStore.setState({
  // focusedBlockId })` partial, which left `selectedBlockIds` /
  // `selectionAnchorId` / `selectionFocusId` untouched. That breaks the
  // #2465 focus/selection mutual-exclusivity invariant: after this, the
  // store could hold BOTH a non-null focus AND a non-empty selection —
  // reachable in journal weekly/monthly views by multi-selecting blocks in
  // one day's tree, then pressing "Add block" for another day.
  it('routes focus through setFocused so the #2465 focus/selection invariant holds', async () => {
    // Simulate a pre-existing block-select-mode selection from another
    // day's tree.
    useBlockStore.setState({
      focusedBlockId: null,
      selectedBlockIds: ['OTHER_A', 'OTHER_B'],
      selectionAnchorId: 'OTHER_A',
      selectionFocusId: 'OTHER_B',
    })

    stubInvoke({ create_block: () => createdBlock('PEXIST', 1) })

    const { result } = setup(new Map([['2025-06-15', 'PEXIST']]))

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const state = useBlockStore.getState()
    expect(state.focusedBlockId).toBe('B1')
    // setFocused clears selection atomically — a raw setState partial
    // would have left the stale multi-select from the other day intact.
    expect(state.selectedBlockIds).toEqual([])
    expect(state.selectionAnchorId).toBeNull()
    expect(state.selectionFocusId).toBeNull()
  })

  it('routes template-seeded focus through setFocused too', async () => {
    useBlockStore.setState({
      focusedBlockId: null,
      selectedBlockIds: ['OTHER_A'],
      selectionAnchorId: 'OTHER_A',
      selectionFocusId: 'OTHER_A',
    })

    stubInvoke({
      create_page_in_space: () => 'PNEW',
      first_child_for_blocks: () => ({ PNEW: makeBlockRow({ id: 'ID1', parent_id: 'PNEW' }) }),
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const state = useBlockStore.getState()
    expect(state.focusedBlockId).toBe('ID1')
    expect(state.selectedBlockIds).toEqual([])
    expect(state.selectionAnchorId).toBeNull()
    expect(state.selectionFocusId).toBeNull()
  })
})

describe('useJournalBlockCreation — journal template page', () => {
  const SPACE = 'SPACE_PERSONAL'
  const DATE = '2031-01-02'

  beforeEach(async () => {
    seedBlocks()
    useSpaceStore.setState({
      currentSpaceId: SPACE,
      availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
      isReady: true,
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  async function seedJournalTemplate(): Promise<string> {
    const templateId = unwrap(await commands.createPageInSpace(null, 'Daily template', SPACE))
    unwrap(
      await commands.setProperty(templateId, 'journal-template', {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }),
    )
    return templateId
  }

  // #5373 — the text template this replaced flattened every line to the top
  // level; the page template must keep its nesting.
  it("copies the template page's nested blocks into a new journal page", async () => {
    const templateId = await seedJournalTemplate()
    const notes = await createBlock({
      blockType: 'content',
      content: 'Notes',
      parentId: templateId,
    })
    await createBlock({ blockType: 'content', content: 'nested idea', parentId: notes.id })

    const { result } = setup()
    await act(async () => {
      await result.current.handleAddBlock(DATE)
    })

    const journalPageId = result.current.createdPages.get(DATE)
    if (journalPageId == null) throw new Error('no journal page was created')
    const { blocks } = unwrap(
      await commands.loadPageSubtree(journalPageId, { kind: 'active', space_id: SPACE }),
    )
    const copiedNotes = blocks.find((b) => b.content === 'Notes')
    const copiedNested = blocks.find((b) => b.content === 'nested idea')
    expect(copiedNotes?.parent_id).toBe(journalPageId)
    expect(copiedNested?.parent_id).toBe(copiedNotes?.id)
  })

  // #5395 — the backend copies the template when it creates the day; the
  // hook renders that day and must not insert the template a second time.
  it('renders a backend-created day once, variables expanded, and focuses its first block', async () => {
    const templateId = await seedJournalTemplate()
    await createBlock({
      blockType: 'content',
      content: 'Notes for <% page title %>',
      parentId: templateId,
    })
    await createBlock({ blockType: 'content', content: 'Later', parentId: templateId })

    const { result } = setup()
    await act(async () => {
      await result.current.handleAddBlock(DATE)
    })

    const journalPageId = result.current.createdPages.get(DATE)
    if (journalPageId == null) throw new Error('no journal page was created')
    const { blocks } = unwrap(
      await commands.loadPageSubtree(journalPageId, { kind: 'active', space_id: SPACE }),
    )
    expect(blocks.map((b) => b.content)).toEqual(['Notes for 2031-01-02', 'Later'])
    const first = blocks[0]
    expect(useBlockStore.getState().focusedBlockId).toBe(first?.id)
  })
})
