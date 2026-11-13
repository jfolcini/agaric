/**
 * Eviction policy of the shared read-path client (#6539). Keys carry typed
 * text (a query, a search, a filter set), so an entry nothing observes is
 * collected; the two property lists, keyed by space and property key, stay
 * for the session.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockedRun } = vi.hoisted(() => ({ mockedRun: vi.fn() }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      batchResolve: () => Promise.resolve({ status: 'ok', data: [] }),
      runAdvancedQuery: (...args: unknown[]) =>
        mockedRun(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import { propertyKeysQueryKey } from '@/lib/property-keys-cache'
import { propertyValuesQueryKey } from '@/lib/property-values-cache'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'

const FIVE_MINUTES = 5 * 60 * 1000
const ONE_DAY = 24 * 60 * 60 * 1000

function advancedQueriesFor(fulltext: string) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ['advancedQuery'], predicate: (q) => q.queryKey.includes(fulltext) })
}

beforeEach(() => {
  useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
  mockedRun.mockResolvedValue({ rows: [], nextCursor: null, hasMore: false, totalCount: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('queryClient eviction', () => {
  it('collects an advanced query nothing observes once the default gcTime passes', async () => {
    const { result, rerender } = renderHook(
      ({ fulltext }: { fulltext: string }) => useAdvancedQuery({ filters: [], fulltext }),
      { initialProps: { fulltext: 'alpha' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(advancedQueriesFor('alpha')).toHaveLength(1)

    vi.useFakeTimers()
    rerender({ fulltext: 'beta' })

    vi.advanceTimersByTime(FIVE_MINUTES - 1)
    expect(advancedQueriesFor('alpha')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(advancedQueriesFor('alpha')).toHaveLength(0)
  })

  it('keeps the property key and value lists for the session', () => {
    vi.useFakeTimers()
    queryClient.setQueryData(propertyKeysQueryKey('SPACE_A'), ['status'])
    queryClient.setQueryData(propertyValuesQueryKey('status'), ['active'])

    vi.advanceTimersByTime(ONE_DAY)

    expect(queryClient.getQueryData(propertyKeysQueryKey('SPACE_A'))).toEqual(['status'])
    expect(queryClient.getQueryData(propertyValuesQueryKey('status'))).toEqual(['active'])
  })
})
