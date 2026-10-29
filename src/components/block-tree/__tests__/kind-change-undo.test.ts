/**
 * An edit that changes a block's kind is one undo step with the list style or
 * task state it takes off (#6156): each path records ONE entry on the page's
 * undo stack holding the op refs of every write the action made, the task
 * state's clear (`delete_property`) among them.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow } from '@/__tests__/fixtures'
import { stubInvoke, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { makeSyntheticCtx } from '@/components/block-tree/use-block-slash-commands/__tests__/test-utils'
import { useSlashCommandStructural } from '@/components/block-tree/use-block-slash-commands/useSlashCommandStructural'
import { useBlockTreeEventListeners } from '@/components/block-tree/use-block-tree-event-listeners'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useListStyleSyntax } from '@/hooks/useListStyleSyntax'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import type { OpRef } from '@/lib/bindings'
import { LIST_STYLE_KEY, setListStyle } from '@/lib/list-style'
import { __resetBlockCommandBus, dispatchBlockCommand } from '@/stores/block-command-bus'
import { useBlockStore } from '@/stores/blocks'
import { clearTaskStates, createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)
const t = ((key: string) => key) as unknown as TFunction

const EDIT: OpRef = { device_id: 'dev1', seq: 1 }
const SET: OpRef = { device_id: 'dev1', seq: 2 }
const DELETE: OpRef = { device_id: 'dev1', seq: 3 }

/** Every command these paths reach, each answering with the op refs it appended. */
function stub(overrides: TypedInvokeHandlers = {}): void {
  stubInvoke(mockedInvoke, {
    edit_block: (args) => ({
      op_refs: [EDIT],
      ...makeBlockRow({ id: args['blockId'] as string, content: args['toText'] as string }),
    }),
    set_property: (args) => ({
      op_refs: [SET],
      ...makeBlockRow({ id: args['blockId'] as string }),
    }),
    delete_property: (args) => ({
      op_refs: [DELETE],
      block_id: args['blockId'] as string,
      key: args['key'] as string,
    }),
    ...overrides,
  })
}

/** The refs of each entry on page `PAGE_1`'s undo stack, newest first; `null` is positional. */
const entries = () =>
  useUndoStore
    .getState()
    .pages.get('PAGE_1')
    ?.undoStack.map((e) => e.refs)

/** Give block `id` of `store` task state `state`. */
function setTodo(store: StoreApi<PageBlockState>, state: string | null, id = 'BLOCK_1'): void {
  store.setState({
    blocks: store
      .getState()
      .blocks.map((b) => (b.id === id ? Object.assign({}, b, { todo_state: state }) : b)),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stub()
  useUndoStore.setState({ pages: new Map() })
})

describe('setListStyle', () => {
  it('resolves the refs of the write it made, for the caller’s undo entry', async () => {
    await expect(setListStyle('BLOCK_1', 'bullet')).resolves.toEqual([SET])
    await expect(setListStyle('BLOCK_1', 'none')).resolves.toEqual([DELETE])
    expect(mockedInvoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      [
        'set_property',
        {
          blockId: 'BLOCK_1',
          key: LIST_STYLE_KEY,
          value: {
            value_text: 'bullet',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        },
      ],
      ['delete_property', { blockId: 'BLOCK_1', key: LIST_STYLE_KEY }],
    ])
  })
})

describe('clearTaskStates', () => {
  it('joins the entry recorded just before, so one undo takes back the style and the task', async () => {
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })
    useUndoStore.getState().onNewAction('PAGE_1', [SET])

    await clearTaskStates(pageStore, ['BLOCK_1'])

    expect(entries()).toEqual([[SET, DELETE]])
  })

  it('records nothing when no block is a task, or when the write is refused', async () => {
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' }), makeBlock({ id: 'BLOCK_2' })] })
    setTodo(pageStore, 'TODO', 'BLOCK_2')
    useUndoStore.getState().onNewAction('PAGE_1', [SET])
    stub({ delete_property: () => Promise.reject(new Error('refused')) })

    await clearTaskStates(pageStore, ['BLOCK_1'])
    await clearTaskStates(pageStore, ['BLOCK_2'])

    expect(entries()).toEqual([[SET]])
  })
})

describe('slash commands', () => {
  const structural = () => renderHook(() => useSlashCommandStructural()).result.current

  it('/h2 on a bulleted block: the edit and the style it clears are one entry', async () => {
    const { ctx } = makeSyntheticCtx()

    await structural().exact['h2']?.(ctx, { id: 'h2', label: 'Heading 2' })

    expect(entries()).toEqual([[EDIT, DELETE]])
  })

  it('Turn into a heading: the edit and the style it clears are one entry', async () => {
    const { ctx } = makeSyntheticCtx()
    const turnInto = structural().prefix.find(([p]) => p === 'turn-')?.[1]

    await turnInto?.(ctx, { id: 'turn-h1', label: 'Heading 1' })

    expect(entries()).toEqual([[EDIT, DELETE]])
  })

  it('/bullet-list on a heading: the edit and the style it writes are one entry', async () => {
    const { ctx } = makeSyntheticCtx({
      blocks: [{ id: 'BLOCK_1', content: '# hello', parent_id: 'PAGE_1' }],
    })

    await structural().exact['bullet-list']?.(ctx, { id: 'bullet-list', label: 'Bullet' })

    expect(entries()).toEqual([[EDIT, SET]])
  })

  it('/bullet-list records its style write; on a task, the task clear joins it', async () => {
    const plain = makeSyntheticCtx()
    await structural().exact['bullet-list']?.(plain.ctx, { id: 'bullet-list', label: 'Bullet' })
    expect(entries()).toEqual([[SET]])

    useUndoStore.setState({ pages: new Map() })
    const task = makeSyntheticCtx()
    setTodo(task.pageStore, 'TODO')
    await structural().exact['bullet-list']?.(task.ctx, { id: 'bullet-list', label: 'Bullet' })
    expect(entries()).toEqual([[SET, DELETE]])
  })
})

describe('a typed list marker', () => {
  it('records its style write; on a task, the task clear joins it', async () => {
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1' }), makeBlock({ id: 'BLOCK_2', todo_state: 'TODO' })],
    })
    const typed = (focusedBlockId: string) =>
      renderHook(() => useListStyleSyntax({ focusedBlockId, t, pageStore })).result.current

    const onPlain = typed('BLOCK_1')
    act(() => onPlain('bullet'))
    await waitFor(() => expect(entries()).toEqual([[SET]]))

    useUndoStore.setState({ pages: new Map() })
    const onTask = typed('BLOCK_2')
    act(() => onTask('ordered'))
    await waitFor(() =>
      expect(pageStore.getState().blocksById.get('BLOCK_2')?.todo_state).toBe(null),
    )
    expect(entries()).toEqual([[SET, DELETE]])
  })
})

describe('the page store’s edit', () => {
  it('a list block whose text stops opening with a paragraph: the edit and the clear are one entry', async () => {
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', content: 'one' })] })

    await pageStore.getState().edit('BLOCK_1', '# one')

    expect(useUndoStore.getState().pages.get('PAGE_1')?.undoStack).toEqual([
      { refs: [EDIT, DELETE], at: expect.any(Number), coalesceKey: 'edit:BLOCK_1' },
    ])
  })
})

describe('the toolbar’s Turn into and callout', () => {
  afterEach(() => {
    __resetBlockCommandBus()
    useBlockStore.setState({ focusedBlockId: null })
  })

  it.each([
    ['TURN_INTO_BLOCK', { type: 'h1' }],
    ['INSERT_CALLOUT', { type: 'tip' }],
  ] as const)('%s: the edit and the style it clears are one entry', async (event, detail) => {
    __resetBlockCommandBus()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', content: 'hello' })] })
    renderHook(() =>
      useBlockTreeEventListeners({
        focusedBlockId: 'BLOCK_1',
        rootParentId: 'PAGE_1',
        handleDiscard: vi.fn(),
        handleToggleTodo: vi.fn(),
        handleTogglePriority: vi.fn(),
        handleShowProperties: vi.fn(),
        handleOpenQueryBuilder: vi.fn(),
        handleOpenEmojiPicker: vi.fn(),
        rovingEditor: { editor: null, mount: vi.fn() } as unknown as RovingEditorHandle,
        datePickerCursorPos: { current: undefined },
        setDatePickerMode: vi.fn(),
        setDatePickerOpen: vi.fn(),
        pageStore,
        t,
      }),
    )

    dispatchBlockCommand(event, detail)

    await waitFor(() => expect(entries()).toEqual([[EDIT, DELETE]]))
  })
})

describe('the block editor’s undo of a change that cleared the style (RESTORE_LIST_STYLE)', () => {
  afterEach(() => {
    __resetBlockCommandBus()
    useBlockStore.setState({ focusedBlockId: null })
  })

  /** A tree whose block `BLOCK_1` the store holds as `content`, and whose editor holds `one`. */
  function listen(content: string): StoreApi<PageBlockState> {
    __resetBlockCommandBus()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })
    const pageStore = createPageBlockStore('PAGE_1')
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', content })] })
    // The editor's pending commit of the text its undo gave back.
    const unregister = registerActiveDraftFlush('BLOCK_1', async () => {
      await pageStore.getState().edit('BLOCK_1', 'one')
    })
    onTestFinished(unregister)
    renderHook(() =>
      useBlockTreeEventListeners({
        focusedBlockId: 'BLOCK_1',
        rootParentId: 'PAGE_1',
        handleDiscard: vi.fn(),
        handleToggleTodo: vi.fn(),
        handleTogglePriority: vi.fn(),
        handleShowProperties: vi.fn(),
        handleOpenQueryBuilder: vi.fn(),
        handleOpenEmojiPicker: vi.fn(),
        rovingEditor: { editor: null, mount: vi.fn() } as unknown as RovingEditorHandle,
        datePickerCursorPos: { current: undefined },
        setDatePickerMode: vi.fn(),
        setDatePickerOpen: vi.fn(),
        pageStore,
        t,
      }),
    )
    return pageStore
  }

  const calls = (name: string) => mockedInvoke.mock.calls.filter(([n]) => n === name)

  it('saves the text the undo gave back, then writes the style, in one entry', async () => {
    listen('# one')

    dispatchBlockCommand('RESTORE_LIST_STYLE', { style: 'bullet' })

    await waitFor(() => expect(entries()).toEqual([[EDIT, SET]]))
    expect(calls('set_property').map(([, args]) => args)).toEqual([
      {
        blockId: 'BLOCK_1',
        key: LIST_STYLE_KEY,
        value: expect.objectContaining({ value_text: 'bullet' }),
      },
    ])
  })

  it('writes nothing while the change is not saved: its save has not cleared the style', async () => {
    const pageStore = listen('one')

    dispatchBlockCommand('RESTORE_LIST_STYLE', { style: 'bullet' })
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', content: '# one' })] })
    dispatchBlockCommand('RESTORE_LIST_STYLE', { style: 'ordered' })

    await waitFor(() => expect(entries()).toEqual([[EDIT, SET]]))
    expect(calls('set_property').map(([, args]) => args)).toEqual([
      {
        blockId: 'BLOCK_1',
        key: LIST_STYLE_KEY,
        value: expect.objectContaining({ value_text: 'ordered' }),
      },
    ])
  })

  it('writes nothing on a block made a task since: a task shows no list style', async () => {
    const pageStore = listen('# one')

    setTodo(pageStore, 'TODO')
    dispatchBlockCommand('RESTORE_LIST_STYLE', { style: 'bullet' })
    setTodo(pageStore, null)
    dispatchBlockCommand('RESTORE_LIST_STYLE', { style: 'ordered' })

    await waitFor(() => expect(entries()).toEqual([[EDIT, SET]]))
    expect(calls('set_property').map(([, args]) => args)).toEqual([
      {
        blockId: 'BLOCK_1',
        key: LIST_STYLE_KEY,
        value: expect.objectContaining({ value_text: 'ordered' }),
      },
    ])
  })
})
