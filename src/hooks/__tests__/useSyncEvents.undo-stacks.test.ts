/**
 * #6541 — what a reload brought by a sync or an out-of-band write does to the
 * open pages' undo and redo stacks, against the real undo store.
 *
 * A sync session appends only the peer's ops, which the backend's positional
 * undo leaves out, so `sync:complete` and the `blocks:changed` that follows it
 * (`local_ops_appended: false`) keep the stacks. A write that appended this
 * device's ops (an MCP write, a mirror ingest; `local_ops_appended: true`, or
 * a payload without the field) shifts that numbering, so the stacks go.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncEvents } from '@/hooks/useSyncEvents'
import type { OpRef } from '@/lib/bindings'
import { useUndoStore } from '@/stores/undo'

const { spies, listeners } = vi.hoisted(() => ({
  spies: { undoOp: vi.fn(), undoPageGroup: vi.fn(), redoPageOp: vi.fn() },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return { ...actual, commands: { ...actual.commands, ...spies } }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    return () => {}
  }),
}))

// Two mounted pages, as the journal's week view mounts one tree per day.
vi.mock('@/stores/page-blocks', () => ({
  forEachLivePageStoreGroup: (fn: (pageId: string, stores: unknown[]) => void) => {
    for (const pageId of ['PAGE_1', 'PAGE_2']) {
      fn(pageId, [{ getState: () => ({ load: async () => {} }) }])
    }
  },
}))

vi.mock('@/stores/resolve', () => ({
  useResolveStore: { getState: () => ({ preload: async () => {} }) },
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: {
    getState: () => ({ currentSpaceId: 'SPACE', refreshAvailableSpaces: async () => {} }),
    subscribe: () => () => {},
  },
}))

const ok = <T>(data: T) => ({ status: 'ok' as const, data })
const ref = (seq: number): OpRef => ({ device_id: 'DEV', seq })

/** The undo store's answer to reverting `seq`, its reverse appended as `newSeq`. */
function undone(seq: number, newSeq: number) {
  return ok({
    reversed_op: ref(seq),
    reversed_op_type: 'edit_block',
    new_op_ref: ref(newSeq),
    new_op_type: 'edit_block',
    is_redo: false,
  })
}

function deliver(event: string, payload: unknown): void {
  const handler = listeners.get(event)
  if (!handler) throw new Error(`no listener for ${event}`)
  handler({ payload })
}

const SYNC_COMPLETE = {
  type: 'complete',
  remote_device_id: 'PEER',
  ops_received: 1,
  ops_sent: 0,
  changed_blocks: 1,
  changed_page_ids: ['PAGE_1'],
}

/** What the backend sends once a session's rebuild drains: nothing of this device's own. */
const AFTER_SYNC = { changed_page_ids: ['PAGE_1'], local_ops_appended: false }

/** Edit twice (seq 1, then seq 2), then undo the newer edit: its reverse is seq 3. */
async function editTwiceAndUndo(pageId: string): Promise<void> {
  const undo = useUndoStore.getState()
  undo.onNewAction(pageId, [ref(1)])
  vi.advanceTimersByTime(1_000)
  undo.onNewAction(pageId, [ref(2)])
  spies.undoOp.mockResolvedValueOnce(undone(2, 3))
  await undo.undo(pageId)
  expect(spies.undoOp).toHaveBeenLastCalledWith(ref(2))
}

let hadTauriInternals: boolean

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // A failed test leaves its queued answers behind; none may reach the next.
  for (const spy of Object.values(spies)) spy.mockReset()
  listeners.clear()
  useUndoStore.setState({ pages: new Map() })
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  }
  renderHook(() => useSyncEvents())
})

afterEach(() => {
  vi.useRealTimers()
  if (!hadTauriInternals) delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('a sync reload keeps the page’s undo and redo (#6541)', () => {
  it('redo restores the edit undone before the sync', async () => {
    await vi.waitFor(() => expect(listeners.size).toBe(3))
    await editTwiceAndUndo('PAGE_1')

    deliver('sync:complete', SYNC_COMPLETE)
    deliver('blocks:changed', AFTER_SYNC)

    spies.redoPageOp.mockResolvedValueOnce(undone(3, 4))
    await useUndoStore.getState().redo('PAGE_1')
    expect(spies.redoPageOp).toHaveBeenCalledWith('DEV', 3)
    expect(
      useUndoStore
        .getState()
        .pages.get('PAGE_1')
        ?.undoStack.map((e) => e.refs),
    ).toEqual([[ref(4)], [ref(1)]])
  })

  it('the next undo reverts the older edit by its ref, not the undone one again', async () => {
    await vi.waitFor(() => expect(listeners.size).toBe(3))
    await editTwiceAndUndo('PAGE_1')

    deliver('sync:complete', SYNC_COMPLETE)
    deliver('blocks:changed', AFTER_SYNC)

    spies.undoOp.mockResolvedValueOnce(undone(1, 5))
    await useUndoStore.getState().undo('PAGE_1')
    expect(spies.undoOp).toHaveBeenLastCalledWith(ref(1))
    expect(spies.undoPageGroup).not.toHaveBeenCalled()
  })

  it('a sync naming no page keeps every mounted page’s stacks', async () => {
    await vi.waitFor(() => expect(listeners.size).toBe(3))
    await editTwiceAndUndo('PAGE_1')
    useUndoStore.getState().onNewAction('PAGE_2', [ref(6)])
    const before = useUndoStore.getState().pages

    deliver('sync:complete', { ...SYNC_COMPLETE, changed_page_ids: [] })
    deliver('blocks:changed', { changed_page_ids: [], local_ops_appended: false })

    expect(useUndoStore.getState().pages).toBe(before)
  })
})

describe('a write that appended local ops drops the page’s undo and redo (#731)', () => {
  it.each([
    ['says so', { changed_page_ids: ['PAGE_1'], local_ops_appended: true }],
    ['does not say', { changed_page_ids: ['PAGE_1'] }],
  ])('a blocks:changed that %s empties both stacks', async (_name, payload) => {
    await vi.waitFor(() => expect(listeners.size).toBe(3))
    await editTwiceAndUndo('PAGE_1')
    useUndoStore.getState().onNewAction('PAGE_2', [ref(6)])

    deliver('blocks:changed', payload)

    expect(useUndoStore.getState().pages.get('PAGE_1')).toEqual({
      undoStack: [],
      redoStack: [],
      undoDepth: 0,
      redoGroupSizes: [],
    })
    expect(useUndoStore.getState().canRedo('PAGE_1')).toBe(false)
    // Only the page the write touched.
    expect(useUndoStore.getState().pages.get('PAGE_2')?.undoStack).toHaveLength(1)
  })
})
