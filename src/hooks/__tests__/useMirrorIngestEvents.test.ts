/**
 * Tests useMirrorIngestEvents: a mirror ingest's ops land on its page's undo
 * stack, a save with warnings says so, and pages trashed, renamed or created
 * from the folder are named or counted in one notice.
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

vi.mock('@/lib/notify', () => ({ notify: { warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }))

import {
  MIRROR_HELD_EVENT,
  MIRROR_INGESTED_EVENT,
  type MirrorIngested,
  useMirrorIngestEvents,
} from '@/hooks/useMirrorIngestEvents'
import type { PageSourceReport } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { useNavigationStore } from '@/stores/navigation'
import { useUndoStore } from '@/stores/undo'

const PAGE = '01JPAGE0000000000000000000'
const OTHER = '01JPAGE0000000000000000001'
const THIRD = '01JPAGE0000000000000000002'
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

async function fire(payload: Omit<MirrorIngested, 'kind'> & Partial<Pick<MirrorIngested, 'kind'>>) {
  await waitFor(() => expect(eventListeners.has(MIRROR_INGESTED_EVENT)).toBe(true))
  eventListeners.get(MIRROR_INGESTED_EVENT)?.({ payload: { kind: 'edited', ...payload } })
}

/** A page `kind` from the folder: no save, so an empty report. */
function fromFolder(kind: MirrorIngested['kind'], page_id: string, path: string) {
  return fire({ kind, page_id, path, op_refs: [REF], report: { ...report(), edited: 0 } })
}

/** The mirror's held space folders as a tick tells them; none once the hold ends. */
async function held(folders: string[]) {
  await waitFor(() => expect(eventListeners.has(MIRROR_HELD_EVENT)).toBe(true))
  eventListeners.get(MIRROR_HELD_EVENT)?.({ payload: folders })
}

afterEach(() => {
  eventListeners.clear()
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ currentView: 'journal', pendingSettingsTab: null })
  vi.clearAllMocks()
})

describe('useMirrorIngestEvents', () => {
  it("puts an ingest's ops on its page's undo stack", async () => {
    renderHook(() => useMirrorIngestEvents())
    await fire({ page_id: PAGE, path: 'S/A.md', op_refs: [REF], report: report() })

    const page = useUndoStore.getState().pages.get(PAGE)
    expect(page?.undoStack[0]?.refs).toEqual([REF])
    expect(notify.warning).not.toHaveBeenCalled()
    expect(notify.info).not.toHaveBeenCalled()
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
      `…${path.slice(-59)} was read in with a warning: ${warning.slice(0, 79)}…`,
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

  // #6887 E — a page trashed, renamed or created from the folder is said.
  it('names a page trashed from the folder, in a notice that stays and opens the Trash', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fromFolder('trashed', PAGE, 'S/A.md')

    expect(vi.mocked(notify.warning).mock.calls).toEqual([
      [
        t('data.mirrorReadBackTrashed', { path: 'S/A.md' }),
        {
          id: 'mirror-read-back',
          duration: Number.POSITIVE_INFINITY,
          action: { label: t('palette.cmdGoTrash'), onClick: expect.any(Function) },
          onDismiss: expect.any(Function),
          onAutoClose: expect.any(Function),
        },
      ],
    ])
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as unknown as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    expect(useNavigationStore.getState().currentView).toBe('trash')
  })

  it('names a page renamed or created from the folder, with no Trash to open', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fromFolder('renamed', PAGE, 'S/B.md')
    let opts = vi.mocked(notify.info).mock.lastCall?.[1] as { onAutoClose: () => void }
    opts.onAutoClose()
    await fromFolder('created', OTHER, 'S/C.md')

    expect(vi.mocked(notify.info).mock.calls.map(([message]) => message)).toEqual([
      t('data.mirrorReadBackRenamed', { path: 'S/B.md' }),
      t('data.mirrorReadBackCreated', { path: 'S/C.md' }),
    ])
    opts = vi.mocked(notify.info).mock.lastCall?.[1] as { onAutoClose: () => void }
    expect(opts).toEqual({
      id: 'mirror-read-back',
      onDismiss: expect.any(Function),
      onAutoClose: expect.any(Function),
    })
    expect(notify.warning).not.toHaveBeenCalled()
  })

  it('counts the pages trashed, renamed and created while its notice is up, each page once', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fromFolder('created', PAGE, 'S/A.md')
    await fromFolder('renamed', OTHER, 'S/B.md')
    // The same page renamed again counts once.
    await fromFolder('renamed', OTHER, 'S/B2.md')
    await fromFolder('trashed', THIRD, 'S/C.md')
    // An edit read in is on its page's undo stack, not in this notice.
    await fire({ page_id: THIRD, path: 'S/D.md', op_refs: [REF], report: report() })

    const changes = new Intl.ListFormat('en', { type: 'conjunction' }).format([
      t('data.mirrorReadBackTrashedCount', { count: 1 }),
      t('data.mirrorReadBackRenamedCount', { count: 1 }),
      t('data.mirrorReadBackCreatedCount', { count: 1 }),
    ])
    expect(vi.mocked(notify.info).mock.calls.map(([message]) => message)).toEqual([
      t('data.mirrorReadBackCreated', { path: 'S/A.md' }),
      t('data.mirrorReadBackSeveral', {
        changes: new Intl.ListFormat('en', { type: 'conjunction' }).format([
          t('data.mirrorReadBackRenamedCount', { count: 1 }),
          t('data.mirrorReadBackCreatedCount', { count: 1 }),
        ]),
      }),
      t('data.mirrorReadBackSeveral', {
        changes: new Intl.ListFormat('en', { type: 'conjunction' }).format([
          t('data.mirrorReadBackRenamedCount', { count: 1 }),
          t('data.mirrorReadBackCreatedCount', { count: 1 }),
        ]),
      }),
    ])
    expect(vi.mocked(notify.warning).mock.calls.map(([message]) => message)).toEqual([
      t('data.mirrorReadBackSeveral', { changes }),
    ])
    expect(changes).toBe('1 page moved to the Trash, 1 page renamed or moved, and 1 new page')
  })

  it('counts afresh once its notice closes, opening the Trash included', async () => {
    renderHook(() => useMirrorIngestEvents())
    await fromFolder('trashed', PAGE, 'S/A.md')
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as unknown as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    await fromFolder('trashed', OTHER, 'S/B.md')

    expect(vi.mocked(notify.warning).mock.lastCall?.[0]).toBe(
      t('data.mirrorReadBackTrashed', { path: 'S/B.md' }),
    )
  })

  // #6964 — a hold is said while Settings is closed, in one notice that stays.
  it('says a hold in one notice that stays and opens Settings › Data', async () => {
    renderHook(() => useMirrorIngestEvents())
    await held(['Work'])
    // A second space held while the first still is updates the same notice.
    await held(['Home', 'Work'])

    const notice = {
      id: 'mirror-held',
      duration: Number.POSITIVE_INFINITY,
      action: { label: t('action.review'), onClick: expect.any(Function) },
    }
    expect(vi.mocked(notify.warning).mock.calls).toEqual([
      [t('data.mirrorHeld', { spaces: 'Work' }), notice],
      [t('data.mirrorHeld', { spaces: 'Home and Work' }), notice],
    ])
    expect(t('data.mirrorHeld', { spaces: 'Work' })).toContain('Work')
    const opts = vi.mocked(notify.warning).mock.lastCall?.[1] as unknown as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    expect(useNavigationStore.getState().currentView).toBe('settings')
    expect(useNavigationStore.getState().pendingSettingsTab).toBe('data')
    expect(notify.dismiss).not.toHaveBeenCalled()
  })

  it('closes the notice once the hold ends, however it ended', async () => {
    renderHook(() => useMirrorIngestEvents())
    await held(['Work'])
    await held([])

    expect(notify.warning).toHaveBeenCalledTimes(1)
    expect(notify.dismiss).toHaveBeenCalledExactlyOnceWith('mirror-held')
  })
})
