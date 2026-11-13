/**
 * useStarredPages — page bookmarks as the synced `bookmark` page property
 * (#6544), whose number is the page's place in the sidebar list.
 *
 * `invoke` is routed through the real tauri-mock `dispatch`, so every
 * assertion re-reads the stored property, not the call that wrote it.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { useStarredPages } from '@/hooks/useStarredPages'
import { t } from '@/lib/i18n'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const QN = SEED_IDS.PAGE_QUICK_NOTES
const PROJ = SEED_IDS.PAGE_PROJECTS
const MEET = SEED_IDS.PAGE_MEETINGS
const GS = SEED_IDS.PAGE_GETTING_STARTED

/** Store a `bookmark` row on `id` the way a synced peer's write lands. */
function seedBookmark(id: string, value: { num?: number; text?: string }): void {
  const held = properties.get(id) ?? new Map<string, Record<string, unknown>>()
  held.set('bookmark', {
    block_id: id,
    key: 'bookmark',
    value_text: value.text ?? null,
    value_num: value.num ?? null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
  properties.set(id, held)
}

/** The stored bookmark number of `id`, or `undefined` when it carries none. */
function storedOrder(id: string): unknown {
  return properties.get(id)?.get('bookmark')?.['value_num']
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
})

describe('useStarredPages', () => {
  it('lists the space bookmarks by number, then title, then id, reading an imported numeric text', async () => {
    // Two devices can each make a "Meetings" page while apart.
    const MEET_TWIN = '00000000000000000000PAGE00'
    blocks.set(MEET_TWIN, { ...blocks.get(MEET), id: MEET_TWIN, page_id: MEET_TWIN })
    seedBookmark(QN, { num: 2 })
    seedBookmark(PROJ, { num: 1 })
    seedBookmark(MEET, { num: 1 })
    seedBookmark(MEET_TWIN, { num: 1 })
    seedBookmark(GS, { text: '1.5' })

    const { result } = renderHook(() => useStarredPages())

    await waitFor(() => {
      expect([...result.current.starredIds]).toEqual([MEET_TWIN, MEET, PROJ, GS, QN])
    })
    expect(result.current.isStarred(QN)).toBe(true)
    expect(result.current.isStarred(SEED_IDS.PAGE_DAILY)).toBe(false)
  })

  it('toggle() bookmarks a page after the last one, and toggling again removes the property', async () => {
    seedBookmark(PROJ, { num: 4 })
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.isStarred(PROJ)).toBe(true))

    act(() => result.current.toggle(QN))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([PROJ, QN]))
    await waitFor(() => expect(storedOrder(QN)).toBe(5))

    act(() => result.current.toggle(QN))

    await waitFor(() => expect(result.current.isStarred(QN)).toBe(false))
    await waitFor(() => expect(properties.get(QN)?.has('bookmark')).toBe(false))
  })

  it('setMany() writes one property per page, in order, and skips pages already bookmarked', async () => {
    seedBookmark(PROJ, { num: 1 })
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.isStarred(PROJ)).toBe(true))

    act(() => result.current.setMany([QN, PROJ, MEET], true))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([PROJ, QN, MEET]))
    await waitFor(() => expect(storedOrder(MEET)).toBe(3))
    expect(storedOrder(QN)).toBe(2)
    expect(storedOrder(PROJ)).toBe(1)

    act(() => result.current.setMany([QN, PROJ], false))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([MEET]))
    await waitFor(() => expect(properties.get(PROJ)?.has('bookmark')).toBe(false))
    expect(properties.get(QN)?.has('bookmark')).toBe(false)
    expect(storedOrder(MEET)).toBe(3)
  })

  it('move() writes only the moved page, between its new neighbours', async () => {
    seedBookmark(QN, { num: 1 })
    seedBookmark(PROJ, { num: 2 })
    seedBookmark(MEET, { num: 3 })
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.starredIds.size).toBe(3))

    act(() => result.current.move(MEET, PROJ))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([QN, MEET, PROJ]))
    await waitFor(() => expect(storedOrder(MEET)).toBe(1.5))
    expect(storedOrder(QN)).toBe(1)
    expect(storedOrder(PROJ)).toBe(2)

    act(() => result.current.move(PROJ, QN))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([PROJ, QN, MEET]))
    await waitFor(() => expect(storedOrder(PROJ)).toBe(0))

    // Down: dropped on the last row, it goes after it.
    act(() => result.current.move(PROJ, MEET))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([QN, MEET, PROJ]))
    await waitFor(() => expect(storedOrder(PROJ)).toBe(2.5))
    expect(storedOrder(QN)).toBe(1)
    expect(storedOrder(MEET)).toBe(1.5)
  })

  it('move() renumbers the space when no number fits between the new neighbours', async () => {
    seedBookmark(QN, { num: 1 })
    seedBookmark(PROJ, { num: 1 })
    seedBookmark(MEET, { num: 2 })
    const { result } = renderHook(() => useStarredPages())
    // Equal numbers order by title: Projects before Quick Notes.
    await waitFor(() => expect([...result.current.starredIds]).toEqual([PROJ, QN, MEET]))

    act(() => result.current.move(MEET, QN))

    await waitFor(() => expect([...result.current.starredIds]).toEqual([PROJ, MEET, QN]))
    await waitFor(() => expect(storedOrder(QN)).toBe(3))
    expect(storedOrder(PROJ)).toBe(1)
    expect(storedOrder(MEET)).toBe(2)
  })

  it('a space switch lists the other space bookmarks', async () => {
    const WORK_PAGE = '00000000000000000WORKPAGE1'
    blocks.set('SPACE_WORK', makeBlock('SPACE_WORK', 'page', 'Work', null, 1))
    blocks.set(WORK_PAGE, {
      ...makeBlock(WORK_PAGE, 'page', 'Plans', null, 2),
      space_id: 'SPACE_WORK',
    })
    seedBookmark(WORK_PAGE, { num: 1 })
    seedBookmark(QN, { num: 1 })
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect([...result.current.starredIds]).toEqual([QN]))

    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' })
    })

    await waitFor(() => expect([...result.current.starredIds]).toEqual([WORK_PAGE]))
  })

  it('keeps starredIds the same object across a re-read that changed nothing', async () => {
    seedBookmark(QN, { num: 1 })
    const { result, rerender } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.isStarred(QN)).toBe(true))
    const first = result.current.starredIds
    const reads = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'query_by_property')

    rerender()
    act(() => invalidateDerivedCaches())
    await waitFor(() => expect(reads()).toHaveLength(2))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(result.current.starredIds).toBe(first)
  })

  it('every mounted instance sees a toggle', async () => {
    const a = renderHook(() => useStarredPages())
    const b = renderHook(() => useStarredPages())
    await waitFor(() => expect(b.result.current.loaded).toBe(true))

    act(() => a.result.current.toggle(QN))

    await waitFor(() => expect(b.result.current.isStarred(QN)).toBe(true))
    await waitFor(() => expect(storedOrder(QN)).toBe(1))
  })

  it('a write that reached the backend some other way shows after the derived caches reset', async () => {
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.starredIds.size).toBe(0)

    seedBookmark(MEET, { num: 1 })
    act(() => invalidateDerivedCaches())

    await waitFor(() => expect(result.current.isStarred(MEET)).toBe(true))
  })

  /** #5293 — a trashed page keeps its bookmark, so a restore must list it again. */
  it('lists a bookmarked page again once a restore from the trash says pages came back', async () => {
    seedBookmark(QN, { num: 1 })
    const page = blocks.get(QN)
    if (page) page['deleted_at'] = '2026-11-01T00:00:00Z'
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.isStarred(QN)).toBe(false)

    // What every restore path does once the restore commits.
    if (page) page['deleted_at'] = null
    act(() => invalidateNameCaches())

    await waitFor(() => expect(result.current.isStarred(QN)).toBe(true))
  })

  it('a failed write puts back what the backend holds', async () => {
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    vi.mocked(invoke).mockImplementation((cmd: string, args?: InvokeArgs) =>
      cmd === 'set_property'
        ? Promise.reject({ kind: 'database', message: 'disk I/O error' })
        : Promise.resolve(dispatch(cmd, args)),
    )
    const reads = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'query_by_property')
    expect(reads()).toHaveLength(1)

    act(() => result.current.toggle(QN))

    await waitFor(() => expect(reads()).toHaveLength(2))
    await waitFor(() => expect(result.current.isStarred(QN)).toBe(false))
  })

  it('a failed write shows one error toast, even when it fails a whole batch', async () => {
    const { result } = renderHook(() => useStarredPages())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    vi.mocked(invoke).mockImplementation((cmd: string, args?: InvokeArgs) =>
      cmd === 'set_property'
        ? Promise.reject({ kind: 'database', message: 'disk I/O error' })
        : Promise.resolve(dispatch(cmd, args)),
    )

    act(() => result.current.setMany([QN, PROJ, MEET], true))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalledWith(t('bookmarks.writeFailed'))
    await waitFor(() => expect(result.current.starredIds.size).toBe(0))
    expect(storedOrder(QN)).toBeUndefined()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
