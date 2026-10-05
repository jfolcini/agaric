/** #5248 — what the origin space sees once pages move out of it. */
import { invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makePageHeading } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { unresolvedBlockLabel } from '@/lib/block-title'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { announcePagesMovedOut } from '@/stores/page-move'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const ORIGIN = 'SPACE_ORIGIN'

describe('announcePagesMovedOut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSpaceStore.setState({
      currentSpaceId: ORIGIN,
      availableSpaces: [{ id: ORIGIN, name: 'Origin', accent_color: null }],
      isReady: true,
    })
    useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  })

  it('renders the moved pages broken in the origin and leaves the rest alone', () => {
    useResolveStore.getState().set('MOVED', 'Moved', false)
    useResolveStore.getState().set('STAYS', 'Stays', false)

    announcePagesMovedOut(['MOVED'], ORIGIN)

    // What a fresh session shows for a target in another space: the broken label, not the title.
    const { resolveStatus, resolveTitle } = useResolveStore.getState()
    expect(resolveStatus('MOVED')).toBe('deleted')
    expect(resolveTitle('MOVED')).toBe(unresolvedBlockLabel('MOVED'))
    expect(resolveStatus('STAYS')).toBe('active')
    expect(resolveTitle('STAYS')).toBe('Stays')
  })

  it("drops the moved pages from the origin's [[ picker, scoped to the origin", async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        list_all_pages_in_space: () => [
          makePageHeading({ id: 'MOVED', content: 'Moved Page' }),
          makePageHeading({ id: 'STAYS', content: 'Stays Page' }),
        ],
      }),
    )
    const { result } = renderHook(() => useBlockResolve())
    await result.current.searchPages('')
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    try {
      announcePagesMovedOut(['MOVED'], ORIGIN)
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([{ kind: 'removed', entity: 'page', id: 'MOVED', spaceId: ORIGIN }])
    const offered = (await result.current.searchPages('')).filter((i) => !i.isCreate)
    expect(offered.map((i) => i.id)).toEqual(['STAYS'])
  })
})
