/**
 * useSavedPagesViews — the active space's Pages-view saved views, view pages
 * carrying the synced `saved_view` property (#6544), and the one the live
 * `{ sort, filters }` tuple matches.
 *
 * `invoke` is routed through the real tauri-mock `dispatch`, so every
 * assertion re-reads the stored pages, not the call that wrote them.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { useSavedPagesViews } from '@/hooks/useSavedPagesViews'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import type { PagesViewTuple } from '@/lib/saved-pages-views'
import { encodeSavedView, saveView } from '@/lib/saved-views'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const SPACE = 'SPACE_PERSONAL'

const BASE_TUPLE: PagesViewTuple = {
  sort: 'alphabetical',
  filters: [],
}

function names(views: ReadonlyArray<{ name: string }>): string[] {
  return views.map((v) => v.name)
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
  useSpaceStore.setState({ currentSpaceId: SPACE })
})

describe('useSavedPagesViews', () => {
  it('lists the space Pages views only, not its saved queries', async () => {
    await saveView(SPACE, 'Pages one', { kind: 'pages', sort: 'recent', filters: [] })
    await saveView(SPACE, 'A query', {
      kind: 'query',
      spec: { filter: { type: 'And', children: [] } },
    })

    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))

    await waitFor(() => expect(names(result.current.views)).toEqual(['Pages one']))
    expect(result.current.views[0]).toMatchObject({ sort: 'recent', filters: [] })
  })

  it('saveView makes a view page every mounted instance lists, and refuses a taken name', async () => {
    const a = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    const b = renderHook(() => useSavedPagesViews(BASE_TUPLE))

    let saved = false
    await act(async () => {
      saved = await a.result.current.saveView('My view', BASE_TUPLE)
    })

    expect(saved).toBe(true)
    await waitFor(() => expect(names(b.result.current.views)).toEqual(['My view']))
    const id = b.result.current.views[0]?.id ?? ''
    expect(blocks.get(id)?.['content']).toBe('My view')

    await act(async () => {
      saved = await a.result.current.saveView('Quick Notes', BASE_TUPLE)
    })
    expect(saved).toBe(false)
  })

  it('deleteView moves the view to the Trash and drops it; restoreView lists it again', async () => {
    await saveView(SPACE, 'Doomed', { kind: 'pages', ...BASE_TUPLE })
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    await waitFor(() => expect(names(result.current.views)).toEqual(['Doomed']))
    const id = result.current.views[0]?.id ?? ''

    let deletedAt = 0
    await act(async () => {
      deletedAt = await result.current.deleteView(id)
    })

    await waitFor(() => expect(result.current.views).toEqual([]))
    expect(blocks.get(id)?.['deleted_at']).not.toBeNull()

    await act(async () => {
      await result.current.restoreView(id, deletedAt)
    })

    await waitFor(() => expect(names(result.current.views)).toEqual(['Doomed']))
  })

  it('a view that reached the backend some other way shows after the derived caches reset', async () => {
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    const reads = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'query_by_property')
    await waitFor(() => expect(reads()).toHaveLength(1))

    // A synced view: written straight to the store, past the writers that re-read.
    const id = dispatch('create_page_in_space', {
      parentId: null,
      content: 'Synced',
      spaceId: SPACE,
    })
    dispatch('set_property', {
      blockId: id,
      key: 'saved_view',
      value: { value_text: encodeSavedView({ kind: 'pages', ...BASE_TUPLE }) },
    })
    expect(result.current.views).toEqual([])

    act(() => invalidateDerivedCaches())

    await waitFor(() => expect(names(result.current.views)).toEqual(['Synced']))
  })

  it('lists a view again once a restore from the Trash says pages came back', async () => {
    await saveView(SPACE, 'Trashed', { kind: 'pages', ...BASE_TUPLE })
    const page = [...blocks.values()].find((b) => b['content'] === 'Trashed')
    if (page) page['deleted_at'] = 1
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    const reads = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'query_by_property')
    await waitFor(() => expect(reads().length).toBeGreaterThan(0))
    expect(result.current.views).toEqual([])

    // What every restore path does once the restore commits.
    if (page) page['deleted_at'] = null
    act(() => invalidateNameCaches())

    await waitFor(() => expect(names(result.current.views)).toEqual(['Trashed']))
  })

  describe('activeView detection', () => {
    it('matches the saved view whose tuple equals the current tuple', async () => {
      await saveView(SPACE, 'Match', { kind: 'pages', ...BASE_TUPLE })
      const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))

      await waitFor(() => expect(result.current.activeView?.name).toBe('Match'))
    })

    it('returns null when the current tuple matches no saved view', async () => {
      await saveView(SPACE, 'Other', { kind: 'pages', ...BASE_TUPLE, sort: 'recent' })
      const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))

      await waitFor(() => expect(names(result.current.views)).toEqual(['Other']))
      expect(result.current.activeView).toBeNull()
    })

    it('returns null when currentTuple is omitted', async () => {
      await saveView(SPACE, 'Untargeted', { kind: 'pages', ...BASE_TUPLE })
      const { result } = renderHook(() => useSavedPagesViews())

      await waitFor(() => expect(names(result.current.views)).toEqual(['Untargeted']))
      expect(result.current.activeView).toBeNull()
    })
  })
})
