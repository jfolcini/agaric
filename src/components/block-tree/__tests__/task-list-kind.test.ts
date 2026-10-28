/**
 * A task is a third list kind, exclusive with bulleted and numbered (#5691
 * D3): making a block a task clears its list style, and making a task
 * bulleted or numbered clears its task state, each only once the kind the
 * user picked is written.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow, makePropertyRow } from '@/__tests__/fixtures'
import { echoEditBlock, stubInvoke, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import {
  clearTaskStates,
  setTodoStateOnBlocks,
} from '@/components/block-tree/use-block-multi-select'
import { useBlockProperties } from '@/components/block-tree/use-block-properties'
import { makeSyntheticCtx } from '@/components/block-tree/use-block-slash-commands/__tests__/test-utils'
import { useSlashCommandProperty } from '@/components/block-tree/use-block-slash-commands/useSlashCommandProperty'
import { useSlashCommandStructural } from '@/components/block-tree/use-block-slash-commands/useSlashCommandStructural'
import { LIST_STYLE_KEY } from '@/lib/list-style'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)
const t = ((key: string) => key) as unknown as TFunction

let pageStore: StoreApi<PageBlockState>

/** Give the blocks of `store` (all, or `id`) task state `state`. */
function setTodo(store: StoreApi<PageBlockState>, state: string | null, id?: string): void {
  store.setState({
    blocks: store
      .getState()
      .blocks.map((b) =>
        id === undefined || b.id === id ? Object.assign({}, b, { todo_state: state }) : b,
      ),
  })
}

const todoOf = (id: string) => pageStore.getState().blocksById.get(id)?.todo_state ?? null
const calls = (command: string) =>
  mockedInvoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args)

/** Every command these flows reach, answering as the backend does; a test overrides one. */
function stub(overrides: TypedInvokeHandlers = {}): void {
  stubInvoke(mockedInvoke, {
    set_todo_state: (args) =>
      makeBlockRow({ id: args['blockId'] as string, todo_state: args['state'] as string | null }),
    set_todo_state_batch: (args) => (args['blockIds'] as string[]).length,
    set_property: (args) => ({
      op_refs: [],
      ...makeBlockRow({ id: args['blockId'] as string }),
    }),
    delete_property: (args) => ({
      op_refs: [],
      block_id: args['blockId'] as string,
      key: args['key'] as string,
    }),
    get_batch_properties: () => ({
      BLOCK_1: [makePropertyRow({ key: LIST_STYLE_KEY, value_text: 'bullet' })],
    }),
    edit_block: echoEditBlock,
    get_property: () => null,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stub()
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: [
      makeBlock({ id: 'BLOCK_1', content: 'one' }),
      makeBlock({ id: 'BLOCK_2', content: 'two', todo_state: 'TODO' }),
      makeBlock({ id: 'BLOCK_3', content: 'three' }),
    ],
  })
})

describe('clearTaskStates', () => {
  it('clears the blocks that hold a task, in one write, and the store follows', async () => {
    setTodo(pageStore, 'DONE', 'BLOCK_3')

    await expect(clearTaskStates(pageStore, ['BLOCK_1', 'BLOCK_2', 'BLOCK_3'])).resolves.toBe(true)

    expect(calls('set_todo_state_batch')).toEqual([
      { blockIds: ['BLOCK_2', 'BLOCK_3'], state: null },
    ])
    expect(['BLOCK_1', 'BLOCK_2', 'BLOCK_3'].map(todoOf)).toEqual([null, null, null])
  })

  it('asks nothing when no block holds a task', async () => {
    await expect(clearTaskStates(pageStore, ['BLOCK_1', 'BLOCK_3'])).resolves.toBe(true)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('a refused write leaves the task, and says so', async () => {
    stub({ set_todo_state_batch: () => Promise.reject(new Error('refused')) })

    await expect(clearTaskStates(pageStore, ['BLOCK_2'])).resolves.toBe(false)

    expect(todoOf('BLOCK_2')).toBe('TODO')
    expect(vi.mocked(toast.error).mock.calls.map(([message]) => message)).toEqual([
      'Failed to set task state',
    ])
  })
})

describe('setTodoStateOnBlocks', () => {
  it('clears the list styles of the blocks it made tasks, after the write', async () => {
    const clearLists = vi.fn(() => {
      expect(calls('set_todo_state_batch')).toHaveLength(1)
    })

    await setTodoStateOnBlocks(pageStore, 'PAGE_1', ['BLOCK_1', 'BLOCK_2'], 'DONE', t, clearLists)

    // BLOCK_2 was a task already: its list style, if it kept one, stays.
    expect(clearLists.mock.calls).toEqual([[['BLOCK_1']]])
  })

  it('by default, block mode clears them with its commands', async () => {
    await setTodoStateOnBlocks(pageStore, 'PAGE_1', ['BLOCK_1', 'BLOCK_3'], 'TODO', t)

    expect(calls('get_batch_properties')).toEqual([{ blockIds: ['BLOCK_1', 'BLOCK_3'] }])
    expect(calls('delete_property')).toEqual([{ blockId: 'BLOCK_1', key: LIST_STYLE_KEY }])
  })

  it('a refused write clears no list style', async () => {
    stub({ set_todo_state_batch: () => Promise.reject(new Error('refused')) })
    const clearLists = vi.fn()

    await setTodoStateOnBlocks(pageStore, 'PAGE_1', ['BLOCK_1'], 'TODO', t, clearLists)

    expect(clearLists).not.toHaveBeenCalled()
  })

  it('clearing the task state clears no list style', async () => {
    const clearLists = vi.fn()

    await setTodoStateOnBlocks(pageStore, 'PAGE_1', ['BLOCK_1', 'BLOCK_2'], null, t, clearLists)

    expect(clearLists).not.toHaveBeenCalled()
  })
})

describe('useBlockProperties handleToggleTodo', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(PageBlockContext.Provider, { value: pageStore }, children)

  it('a block the cycle makes a task loses its list style, after the write', async () => {
    const clearLists = vi.fn(() => {
      expect(calls('set_todo_state')).toHaveLength(1)
    })
    const { result } = renderHook(() => useBlockProperties(clearLists), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(todoOf('BLOCK_1')).toBe('TODO')
    expect(clearLists.mock.calls).toEqual([[['BLOCK_1']]])
  })

  it('a refused write clears no list style', async () => {
    stub({ set_todo_state: () => Promise.reject(new Error('refused')) })
    const clearLists = vi.fn()
    const { result } = renderHook(() => useBlockProperties(clearLists), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(todoOf('BLOCK_1')).toBeNull()
    expect(clearLists).not.toHaveBeenCalled()
  })

  it('cycling a task on, or back to no state, clears no list style', async () => {
    const clearLists = vi.fn()
    setTodo(pageStore, 'CANCELLED', 'BLOCK_1')
    const { result } = renderHook(() => useBlockProperties(clearLists), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_2')
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect([todoOf('BLOCK_1'), todoOf('BLOCK_2')]).toEqual([null, 'DOING'])
    expect(clearLists).not.toHaveBeenCalled()
  })
})

describe('slash commands', () => {
  const todoCommand = async (ctx: ReturnType<typeof makeSyntheticCtx>['ctx']) => {
    const { result } = renderHook(() => useSlashCommandProperty())
    await result.current.exact['todo']?.(ctx, { id: 'todo', label: 'TODO' })
  }
  const structural = () => renderHook(() => useSlashCommandStructural()).result.current

  it('/todo on a plain block clears its list style, through page mode’s clear there', async () => {
    const { ctx } = makeSyntheticCtx()
    const clearListStyle = vi.fn(() => {
      expect(calls('set_todo_state')).toHaveLength(1)
    })

    await todoCommand({ ...ctx, clearListStyle })

    expect(clearListStyle).toHaveBeenCalledTimes(1)
  })

  it('/todo in block mode clears it with block mode’s commands', async () => {
    const { ctx } = makeSyntheticCtx()

    await todoCommand(ctx)

    expect(calls('delete_property')).toEqual([{ blockId: 'BLOCK_1', key: LIST_STYLE_KEY }])
  })

  it('/todo refused, or on a block that is a task already, clears no list style', async () => {
    const { ctx, pageStore: store } = makeSyntheticCtx()
    const clearListStyle = vi.fn()
    stub({ set_todo_state: () => Promise.reject(new Error('refused')) })
    await todoCommand({ ...ctx, clearListStyle })
    expect(clearListStyle).not.toHaveBeenCalled()

    stub()
    setTodo(store, 'DONE')
    await todoCommand({ ...ctx, clearListStyle })
    expect(clearListStyle).not.toHaveBeenCalled()
  })

  it('/bullet-list on a task clears its task state once the style is written', async () => {
    const { ctx, pageStore: store } = makeSyntheticCtx()
    setTodo(store, 'TODO')

    await structural().exact['bullet-list']?.(ctx, { id: 'bullet-list', label: 'Bullet list' })

    expect(mockedInvoke.mock.calls.map(([name]) => name)).toEqual([
      'set_property',
      'set_todo_state_batch',
    ])
    expect(calls('set_todo_state_batch')).toEqual([{ blockIds: ['BLOCK_1'], state: null }])
    expect(store.getState().blocksById.get('BLOCK_1')?.todo_state).toBeNull()
  })

  it('/numbered-list refused leaves the task', async () => {
    const { ctx, pageStore: store } = makeSyntheticCtx()
    setTodo(store, 'TODO')
    stub({ set_property: () => Promise.reject(new Error('refused')) })

    await structural().exact['numbered-list']?.(ctx, {
      id: 'numbered-list',
      label: 'Numbered list',
    })

    expect(calls('set_todo_state_batch')).toEqual([])
    expect(store.getState().blocksById.get('BLOCK_1')?.todo_state).toBe('TODO')
  })

  it('Turn into a bullet list clears the task; Turn into a heading does not', async () => {
    const { ctx, pageStore: store } = makeSyntheticCtx()
    setTodo(store, 'TODO')
    const turnInto = structural().prefix.find(([p]) => p === 'turn-')?.[1]

    await turnInto?.(ctx, { id: 'turn-h1', label: 'Heading 1' })
    expect(calls('set_todo_state_batch')).toEqual([])

    await turnInto?.(ctx, { id: 'turn-bullet-list', label: 'Bullet list' })
    expect(calls('set_todo_state_batch')).toEqual([{ blockIds: ['BLOCK_1'], state: null }])
    expect(store.getState().blocksById.get('BLOCK_1')?.todo_state).toBeNull()
  })
})
