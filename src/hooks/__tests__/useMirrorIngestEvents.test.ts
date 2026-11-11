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
    expect(vi.mocked(notify.warning).mock.calls[0]?.[0]).toContain('kept twice')
  })
})
