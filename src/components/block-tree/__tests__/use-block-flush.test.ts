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

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks as mockBlocks,
  makeBlock as makeMockBlock,
  properties as mockProperties,
  seedBlocks,
} from '@/lib/tauri-mock/seed'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'

// Force the multi-block detector to see a single block so flush takes the
// checkbox branch regardless of how the real serializer tokenizes a task item.
vi.mock('@/editor/markdown-serializer', () => ({
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
    markCommitted: vi.fn(),
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

// ===========================================================================
// #2675 — inline `key:: value` property lines
//
// These tests wire `invoke` to the REAL tauri-mock `dispatch` (the #2656
// pattern) so the mock's `set_property` validation — empty-value rejection +
// select-option membership — is actually enforced, instead of a per-command
// stub that would pass an invalid write silently. The seeded definitions used:
//   context → text (free-form)
//   project → select, options ["alpha","beta","gamma"]
// ===========================================================================

describe('useBlockFlush — inline `key:: value` properties (#2675)', () => {
  // 26-char mock-convention id, distinct from the seeded fixture blocks.
  const BLK = 'BLK2675'.padStart(26, '0')

  beforeEach(() => {
    // Route every IPC through the real mock dispatch + reseed the fixture
    // (property definitions for `context` / `project` live in the seed).
    mockedInvoke.mockImplementation(
      async (cmd: string, args?: unknown) => dispatch(cmd, args) as never,
    )
    seedBlocks()
    mockBlocks.set(BLK, makeMockBlock(BLK, 'block', '', null, 0))
    // Mirror the block into the page store so `edit()` has a row to update.
    pageStore.setState({ blocks: [makeBlock({ id: BLK, content: '', todo_state: null })] })
  })

  it('commits the typed value via set_property and strips the line from the content', async () => {
    const handle = makeHandle(BLK, 'context:: home')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // The property landed in the (validation-enforcing) mock store.
    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('context')?.['value_text']).toBe('home')
    })
    // The property line was stripped from the committed content.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: '' }),
      )
    })
    expect(pageStore.getState().blocksById.get(BLK)?.content).toBe('')
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('strips only the property line, preserving surrounding content lines', async () => {
    const handle = makeHandle(BLK, 'notes for today\ncontext:: home')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('context')?.['value_text']).toBe('home')
    })
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'notes for today' }),
      )
    })
  })

  it('handles serialized hard breaks: `\\`-suffixed lines parse clean values and strip clean', async () => {
    // Shift+Enter serializes as `\` + newline. The marker must not leak into
    // the stored value, and stripping the final line must not leave the
    // preceding line with a dangling `\`.
    const handle = makeHandle(BLK, 'notes for today\\\ncontext:: home')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('context')?.['value_text']).toBe('home')
    })
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'notes for today' }),
      )
    })
  })

  it('on a REJECTED write (select membership) leaves the line literal and toasts once', async () => {
    // `project` is a select with options alpha/beta/gamma — 'delta' is invalid,
    // so the mock's #2656 validation rejects the set_property call.
    const handle = makeHandle(BLK, 'project:: delta')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to set property')
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    // Nothing stored; the typed text survives verbatim.
    expect(mockProperties.get(BLK)?.get('project')).toBeUndefined()
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'project:: delta' }),
      )
    })
    expect(pageStore.getState().blocksById.get(BLK)?.content).toBe('project:: delta')
  })

  it('partial success: the succeeded line is stripped, the rejected line stays literal', async () => {
    const handle = makeHandle(BLK, 'context:: home\nproject:: delta')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('context')?.['value_text']).toBe('home')
    })
    expect(mockProperties.get(BLK)?.get('project')).toBeUndefined()
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'project:: delta' }),
      )
    })
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to set property')
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
  })

  it('a valid select value IS committed (option membership passes)', async () => {
    const handle = makeHandle(BLK, 'project:: beta')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('project')?.['value_text']).toBe('beta')
    })
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: '' }),
      )
    })
  })

  it('updates an EXISTING value on the block (set_property upsert, drawer parity)', async () => {
    if (!mockProperties.has(BLK)) mockProperties.set(BLK, new Map())
    mockProperties.get(BLK)?.set('context', {
      key: 'context',
      value_text: '@office',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })

    const handle = makeHandle(BLK, 'context:: @remote')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockProperties.get(BLK)?.get('context')?.['value_text']).toBe('@remote')
    })
  })

  it('an empty value (`key:: ` then blur) writes NO property and keeps the text literal', async () => {
    const handle = makeHandle(BLK, 'context:: ')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // Sync plain-edit path: no set_property dispatch at all.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'context:: ' }),
      )
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(mockProperties.get(BLK)?.get('context')).toBeUndefined()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('a newer SYNC plain flush supersedes an in-flight property flush (no stale clobber)', async () => {
    // Blur (property flush, set_property in flight) → quick refocus → the
    // user deletes the property line and types prose → blur (plain sync
    // flush). The plain path bumps the shared seq token, so when the stale
    // property run's IPC finally resolves it must BAIL instead of committing
    // its stripped OLD content over the newer prose.
    let releaseSet: () => void = () => {}
    const gate = new Promise<void>((res) => {
      releaseSet = res
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'set_property') {
        await gate // hold the property write in flight
      }
      return dispatch(cmd, args) as never
    })

    const ref = { current: makeHandle(BLK, 'context:: home') }
    const { result } = renderHook(() =>
      useBlockFlush(makeParams(ref.current, { rovingEditorRef: ref })),
    )

    await act(async () => {
      result.current() // flush 1 — async property path, gated in flight
      await Promise.resolve()
    })

    // Newer editing session on the same block, no property lines → sync path.
    ref.current = makeHandle(BLK, 'rewritten prose')
    await act(async () => {
      result.current() // flush 2 — bumps the seq token and commits
    })
    await waitFor(() => {
      expect(pageStore.getState().blocksById.get(BLK)?.content).toBe('rewritten prose')
    })

    // Release the stale run — it must bail without calling edit().
    await act(async () => {
      releaseSet()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pageStore.getState().blocksById.get(BLK)?.content).toBe('rewritten prose')
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'edit_block',
      expect.objectContaining({ blockId: BLK, toText: '' }),
    )
  })

  it('non-property `::` text (std::vector, mid-sentence ::) saves verbatim with no writes', async () => {
    const handle = makeHandle(BLK, 'use std::vector<int> here')
    const { result } = renderHook(() => useBlockFlush(makeParams(handle)))

    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: BLK, toText: 'use std::vector<int> here' }),
      )
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })
})
