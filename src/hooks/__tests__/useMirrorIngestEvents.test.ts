/**
 * Tests useMirrorIngestEvents: a mirror ingest's ops land on its page's undo
 * stack, and a save with warnings says so.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

vi.mock('@/lib/notify', () => ({ notify: { warning: vi.fn() } }))

import {
  MIRROR_INGESTED_EVENT,
  type MirrorIngested,
  useMirrorIngestEvents,
} from '@/hooks/useMirrorIngestEvents'
import type { PageSourceReport } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { useUndoStore } from '@/stores/undo'

const PAGE = '01JPAGE0000000000000000000'
const REF = { device_id: 'dev', seq: 7 }

function report(warnings: string[] = []): PageSourceReport {
  return {
    created: 0,
    edited: 1,
    moved: 0,
    deleted: 0,
    properties_set: 0,
    properties_deleted: 0,
    names_created: [],
    warnings,
  }
}

async function fire(payload: MirrorIngested) {
  await waitFor(() => expect(eventListeners.has(MIRROR_INGESTED_EVENT)).toBe(true))
  eventListeners.get(MIRROR_INGESTED_EVENT)?.({ payload })
}

afterEach(() => {
  eventListeners.clear()
  useUndoStore.setState({ pages: new Map() })
  vi.clearAllMocks()
})

describe('useMirrorIngestEvents', () => {
  it("puts an ingest's ops on its page's undo stack", async () => {
    renderHook(() => useMirrorIngestEvents())
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [REF], report: report() })

    const page = useUndoStore.getState().pages.get(PAGE)
    expect(page?.undoStack[0]?.refs).toEqual([REF])
    expect(notify.warning).not.toHaveBeenCalled()
  })

  it('pushes nothing for an ingest that wrote nothing, and warns on warnings', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [], report: report(['kept twice']) })

    expect(useUndoStore.getState().pages.get(PAGE)).toBeUndefined()
    expect(notify.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notify.warning).mock.calls[0]?.[0]).toBe(
      'S/A.md was read in with a warning: kept twice',
    )
  })

  // #6870 — one toast for the type: a file is named, several are counted.
  it('names one file, counts several, and starts over once the toast closes', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [], report: report(['kept twice']) })
    // An autosaving editor reads the same file again.
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [], report: report(['kept twice']) })
    await fire({ page_id: PAGE, path: 'S/B.md', op_refs: [], report: report(['bad date']) })
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as { onAutoClose: () => void }
    opts.onAutoClose()
    await fire({ page_id: PAGE, path: 'S/C.md', op_refs: [], report: report(['bad date']) })

    expect(vi.mocked(notify.warning).mock.calls.map(([message]) => message)).toEqual([
      'S/A.md was read in with a warning: kept twice',
      'S/A.md was read in with a warning: kept twice',
      '2 files were read in with warnings',
      'S/C.md was read in with a warning: bad date',
    ])
    expect(vi.mocked(notify.warning).mock.calls[0]?.[1]).toEqual({
      id: 'mirror-ingest-warnings',
      onDismiss: expect.any(Function),
      onAutoClose: expect.any(Function),
    })
  })

  it('shortens a long path and warning so the toast keeps its size', async () => {
    renderHook(() => useMirrorIngestEvents())
    const path = `Space/${'deep/'.repeat(12)}Note.md`
    const warning = `a property line kept as text because ${'it is long '.repeat(8)}`
    await fire({ page_id: PAGE, path, op_refs: [], report: report([warning]) })

    expect(vi.mocked(notify.warning).mock.lastCall?.[0]).toBe(
      `${path.slice(0, 59)}… was read in with a warning: ${warning.slice(0, 79)}…`,
    )
  })

  it('counts afresh once the user closes the toast', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [], report: report(['kept twice']) })
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as { onDismiss: () => void }
    opts.onDismiss()
    await fire({ page_id: PAGE, path: 'S/B.md', op_refs: [], report: report(['bad date']) })

    expect(vi.mocked(notify.warning).mock.lastCall?.[0]).toBe(
      'S/B.md was read in with a warning: bad date',
    )
  })
})
