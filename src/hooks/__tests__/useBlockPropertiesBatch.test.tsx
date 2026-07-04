// @vitest-environment jsdom

/**
 * Tests for useBlockPropertiesBatch — projects the row-UI "extra"
 * property map from the SHARED `BatchPropertiesProvider` batch (#2288).
 *
 * The hook no longer fires its own `getBatchProperties` IPC; it reshapes
 * the raw `PropertyRow[]` the provider already fetched. These tests mount
 * it inside a real provider (mocking the provider's single IPC) and
 * validate:
 *   - `{}` outside a provider (isolated renders fall back to nothing)
 *   - the built-in badge-field filter (todo/priority/due/scheduled)
 *   - typed-value flattening (text → date → num) + empty-value drop
 *   - per-block array separation
 *   - ONE batch for the whole page (consolidation invariant)
 *   - per-block + whole-map reference stability across a no-op re-render
 *   - refresh on the provider's `invalidationKey` bump (the stronger
 *     invalidation the row chips inherit by sourcing from the provider)
 */

import { render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  getBatchProperties: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import type { PropertyRow } from '../../lib/tauri'
import { getBatchProperties } from '../../lib/tauri'
import { BatchPropertiesProvider } from '../useBatchProperties'
import { useBlockPropertiesBatch } from '../useBlockPropertiesBatch'

const mockedGetBatchProperties = vi.mocked(getBatchProperties)

function row(overrides: Partial<PropertyRow> & { key: string }): PropertyRow {
  return {
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...overrides,
  }
}

/**
 * renderHook wrapper that mounts the hook inside a real
 * `BatchPropertiesProvider` for the given block ids (+ optional
 * invalidation key).
 */
function providerWrapper(blockIds: string[], invalidationKey?: string | number) {
  return ({ children }: { children: ReactNode }) => (
    <BatchPropertiesProvider
      blockIds={blockIds}
      {...(invalidationKey === undefined ? {} : { invalidationKey })}
    >
      {children}
    </BatchPropertiesProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetBatchProperties.mockResolvedValue({})
})

describe('useBlockPropertiesBatch (provider-projected, #2288)', () => {
  it('returns an empty map with no provider mounted', () => {
    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]))
    expect(result.current).toEqual({})
    expect(mockedGetBatchProperties).not.toHaveBeenCalled()
  })

  it('returns an empty map (and the provider fires no IPC) when there are no blocks', async () => {
    const { result } = renderHook(() => useBlockPropertiesBatch([]), {
      wrapper: providerWrapper([]),
    })
    await new Promise<void>((r) => queueMicrotask(r))
    expect(result.current).toEqual({})
    expect(mockedGetBatchProperties).not.toHaveBeenCalled()
  })

  it('issues a SINGLE batch for the whole page and projects it into the row map', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [row({ key: 'effort', value_text: '2h' })],
      B2: [row({ key: 'assignee', value_text: 'alice' })],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }, { id: 'B2' }]), {
      wrapper: providerWrapper(['B1', 'B2']),
    })

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '2h' }])
    })
    // Consolidation invariant: exactly one page-wide batch, over the full set.
    expect(mockedGetBatchProperties).toHaveBeenCalledTimes(1)
    expect(mockedGetBatchProperties).toHaveBeenCalledWith(['B1', 'B2'])
    expect(result.current['B2']).toEqual([{ key: 'assignee', value: 'alice' }])
  })

  it('filters out the four built-in badge fields', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [
        row({ key: 'todo_state', value_text: 'TODO' }),
        row({ key: 'priority', value_num: 1 }),
        row({ key: 'due_date', value_date: '2025-01-01' }),
        row({ key: 'scheduled_date', value_date: '2025-01-02' }),
        row({ key: 'effort', value_text: '2h' }),
      ],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]), {
      wrapper: providerWrapper(['B1']),
    })

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '2h' }])
    })
  })

  it('flattens typed value fields (text → date → num) and drops empty values', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [
        row({ key: 'note', value_text: 'hello' }),
        row({ key: 'when', value_date: '2025-03-04' }),
        row({ key: 'count', value_num: 42 }),
        row({ key: 'blank' }),
      ],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]), {
      wrapper: providerWrapper(['B1']),
    })

    await waitFor(() => {
      expect(result.current['B1']).toEqual([
        { key: 'note', value: 'hello' },
        { key: 'when', value: '2025-03-04' },
        { key: 'count', value: '42' },
      ])
    })
  })

  it('keeps separate property arrays per block', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [row({ key: 'effort', value_text: '1h' })],
      B2: [row({ key: 'assignee', value_text: 'alice' })],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }, { id: 'B2' }]), {
      wrapper: providerWrapper(['B1', 'B2']),
    })

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '1h' }])
      expect(result.current['B2']).toEqual([{ key: 'assignee', value: 'alice' }])
    })
  })

  it('reuses per-block AND whole-map references when the blocks array is reallocated with the same ids', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [row({ key: 'effort', value_text: '2h' })],
    })

    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: Array<{ id: string }> }) => useBlockPropertiesBatch(blocks),
      { initialProps: { blocks: [{ id: 'B1' }] }, wrapper: providerWrapper(['B1']) },
    )

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '2h' }])
    })
    const firstMap = result.current
    const firstArray = result.current['B1']

    // Reorder/indent/dedent in the page store reallocates the outer array
    // with the SAME ids. The provider does not refetch (id membership is
    // unchanged), so both the map and the per-block array stay reference-
    // stable — the `SortableBlockWrapper` React.memo bypass survives.
    rerender({ blocks: [{ id: 'B1' }] })
    rerender({ blocks: [{ id: 'B1' }] })

    expect(mockedGetBatchProperties).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(firstMap)
    expect(result.current['B1']).toBe(firstArray)
  })

  it('refreshes when the provider invalidationKey bumps (property-change / space-switch path)', async () => {
    mockedGetBatchProperties.mockResolvedValueOnce({
      B1: [row({ key: 'effort', value_text: '2h' })],
    })

    const captured: Array<Record<string, Array<{ key: string; value: string }>>> = []
    function Probe() {
      captured.push(useBlockPropertiesBatch([{ id: 'B1' }]))
      return null
    }

    const { rerender } = render(
      <BatchPropertiesProvider blockIds={['B1']} invalidationKey={0}>
        <Probe />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      expect(captured.at(-1)?.['B1']).toEqual([{ key: 'effort', value: '2h' }])
    })

    // A property edit fires `block:properties-changed`; BlockTree bumps the
    // provider's invalidationKey → the batch refetches → the row chips
    // reflect the new value. (The old self-batching hook only refetched on
    // an id-set change, so this path was previously NOT covered.)
    mockedGetBatchProperties.mockResolvedValueOnce({
      B1: [row({ key: 'effort', value_text: '4h' })],
    })
    rerender(
      <BatchPropertiesProvider blockIds={['B1']} invalidationKey={1}>
        <Probe />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      expect(captured.at(-1)?.['B1']).toEqual([{ key: 'effort', value: '4h' }])
    })
    expect(mockedGetBatchProperties).toHaveBeenCalledTimes(2)
  })
})
