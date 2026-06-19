/**
 * Tests for useBlockFlush — checkbox-markdown coordination (#1074).
 *
 * The flush callback's `if (todoState)` branch used to fire `set_todo_state`
 * and, REGARDLESS of its outcome, optimistically write `todo_state` (with no
 * rollback) AND strip the `- [ ] `/`- [x] ` marker via `edit()`. A rejected
 * state write therefore left the task state silently and unrecoverably lost
 * (marker gone, state never committed) or a phantom checked box the backend
 * never recorded.
 *
 * These tests pin the coordinated behavior:
 * - SUCCESS: the marker is stripped (cleaned content persisted) and the
 *   block's `todo_state` is set, adopting the backend echo.
 * - FAILURE: the marker is NOT stripped (raw content with the marker is
 *   persisted so the box stays re-parseable) and NO optimistic `todo_state`
 *   is written (no drift / nothing to roll back).
 *
 * The serializer `parse()` is mocked to a single-block doc so the callback
 * takes the checkbox branch deterministically, isolating the IPC
 * coordination from markdown round-tripping.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '../../../__tests__/fixtures'
import type { RovingEditorHandle } from '../../../editor/use-roving-editor'
import { createPageBlockStore, type PageBlockState } from '../../../stores/page-blocks'
import { useBlockFlush } from '../use-block-flush'

// Force the multi-block detector to see a single block so flush takes the
// checkbox branch regardless of how the real serializer tokenizes a task item.
vi.mock('../../../editor/markdown-serializer', () => ({
  parse: () => ({ content: [{ type: 'paragraph' }] }),
}))

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

/** A minimal RovingEditorHandle that flushes `content` for `blockId`. */
function makeHandle(blockId: string, content: string): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => content),
    activeBlockId: blockId,
    getMarkdown: vi.fn(() => content),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnMarkdownChange: vi.fn(),
  }
}

function makeParams(
  handle: RovingEditorHandle,
  overrides?: Partial<Parameters<typeof useBlockFlush>[0]>,
): Parameters<typeof useBlockFlush>[0] {
  return {
    rovingEditorRef: { current: handle },
    edit: pageStore.getState().edit,
    splitBlock: pageStore.getState().splitBlock,
    rootParentId: null,
    pageStore,
    t: vi.fn((key: string) => key) as unknown as TFunction,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ loading: false })
})

describe('useBlockFlush — checkbox markdown', () => {
  it('on set_todo_state SUCCESS strips the marker and sets todo_state (echo adopted)', async () => {
    const block = makeBlock({ id: 'BLK', content: '', todo_state: null })
    pageStore.setState({ blocks: [block] })

    // set_todo_state echoes the canonical row; edit_block echoes the cleaned text.
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'set_todo_state') {
        return Promise.resolve({ ...block, todo_state: 'TODO' })
      }
      if (cmd === 'edit_block') {
        return Promise.resolve({ ...block, content: 'task', todo_state: 'TODO' })
      }
      return Promise.resolve(undefined)
    })

    const handle = makeHandle('BLK', '- [ ] task')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
        blockId: 'BLK',
        state: 'TODO',
      })
    })
    // The marker is stripped: edit() persists the cleaned content.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: 'BLK', toText: 'task' }),
      )
    })
    // The optimistic + echo-adopted state landed in the store.
    await waitFor(() => {
      expect(pageStore.getState().blocksById.get('BLK')?.todo_state).toBe('TODO')
    })
    expect(pageStore.getState().blocksById.get('BLK')?.content).toBe('task')
  })

  it('on set_todo_state FAILURE does NOT strip the marker and writes no optimistic todo_state', async () => {
    const block = makeBlock({ id: 'BLK', content: '', todo_state: null })
    pageStore.setState({ blocks: [block] })

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'set_todo_state') {
        return Promise.reject(new Error('IPC down'))
      }
      // edit_block echoes whatever it was sent.
      if (cmd === 'edit_block') {
        return Promise.resolve({ ...block, content: '- [ ] task' })
      }
      return Promise.resolve(undefined)
    })

    const handle = makeHandle('BLK', '- [ ] task')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setTaskStateFailed')
    })

    // The marker survives: the raw content (with `- [ ] `) is persisted so the
    // box stays re-parseable, NOT the cleaned 'task'.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: 'BLK', toText: '- [ ] task' }),
      )
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ toText: 'task' }),
    )
    // No optimistic todo_state was written → no drift.
    expect(pageStore.getState().blocksById.get('BLK')?.todo_state).toBeNull()
    expect(pageStore.getState().blocksById.get('BLK')?.content).toBe('- [ ] task')
  })

  it('a superseding second flush on the same block wins; the stale late edit bails (#1591)', async () => {
    const block = makeBlock({ id: 'BLK', content: '', todo_state: null })
    pageStore.setState({ blocks: [block] })

    // Hold the FIRST set_todo_state open so the second flush can supersede it
    // before the first resolves, forcing the late-resolve ordering.
    let releaseFirst!: (echo: unknown) => void
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let setTodoCalls = 0
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'set_todo_state') {
        setTodoCalls += 1
        // First call hangs on the gate; second resolves immediately.
        return setTodoCalls === 1 ? firstGate : Promise.resolve({ ...block, todo_state: 'DONE' })
      }
      if (cmd === 'edit_block') {
        // Echo whatever cleaned text it was sent.
        return Promise.resolve({ ...block })
      }
      return Promise.resolve(undefined)
    })

    // A SINGLE hook instance (one shared sequence-token map) whose roving
    // editor ref is swapped between flushes — mirroring how BlockTree reuses
    // the stable callback across edits.
    const handle1 = makeHandle('BLK', '- [ ] task')
    const rovingEditorRef = { current: handle1 as RovingEditorHandle | null }
    const { result } = renderHook(() => useBlockFlush(makeParams(handle1, { rovingEditorRef })))

    // First flush: unchecked box → TODO. Stays in flight on the gate.
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // Second flush on the SAME block while the first is still in flight:
    // checked box → DONE. This bumps the block's shared sequence token.
    rovingEditorRef.current = makeHandle('BLK', '- [x] task')
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // The newer (DONE) flush settles first and wins.
    await waitFor(() => {
      expect(pageStore.getState().blocksById.get('BLK')?.todo_state).toBe('DONE')
    })
    const editCallsBeforeRelease = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'edit_block',
    ).length

    // Now release the stale FIRST set_todo_state. Its IIFE re-checks the token,
    // sees it was superseded, and bails WITHOUT writing todo_state or calling edit.
    await act(async () => {
      releaseFirst({ ...block, todo_state: 'TODO' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The stale TODO write never lands; DONE stands.
    expect(pageStore.getState().blocksById.get('BLK')?.todo_state).toBe('DONE')
    // The stale run did not issue another edit_block (no clobber).
    const editCallsAfterRelease = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'edit_block',
    ).length
    expect(editCallsAfterRelease).toBe(editCallsBeforeRelease)
  })

  it('non-checkbox content saves the changed text verbatim via edit', async () => {
    const block = makeBlock({ id: 'BLK', content: 'old', todo_state: null })
    pageStore.setState({ blocks: [block] })

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'edit_block') return Promise.resolve({ ...block, content: 'plain text' })
      return Promise.resolve(undefined)
    })

    const handle = makeHandle('BLK', 'plain text')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: 'BLK', toText: 'plain text' }),
      )
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_todo_state', expect.anything())
    expect(pageStore.getState().blocksById.get('BLK')?.todo_state).toBeNull()
  })
})
