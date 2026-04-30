/**
 * Tests for useBlockPropertiesBatch — batch-fetches "extra" per-block
 * properties for the row UI. Validates the empty-list early return,
 * the built-in key filter, the typed-value flattening order, and
 * graceful error handling.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  getBatchProperties: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../../lib/logger'
import type { PropertyRow } from '../../lib/tauri'
import { getBatchProperties } from '../../lib/tauri'
import { useBlockPropertiesBatch } from '../useBlockPropertiesBatch'

const mockedGetBatchProperties = vi.mocked(getBatchProperties)
const mockedLoggerWarn = vi.mocked(logger.warn)

function row(overrides: Partial<PropertyRow> & { key: string }): PropertyRow {
  return {
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default impl — the hook re-runs on state change because the test's
  // renderHook callback creates a fresh `blocks` array each render. Tests
  // that need a specific payload override with `.mockResolvedValueOnce`.
  mockedGetBatchProperties.mockResolvedValue({})
})

describe('useBlockPropertiesBatch', () => {
  it('returns the empty map and skips the IPC when no blocks are provided', async () => {
    const { result } = renderHook(() => useBlockPropertiesBatch([]))

    await new Promise<void>((r) => queueMicrotask(r))
    expect(result.current).toEqual({})
    expect(mockedGetBatchProperties).not.toHaveBeenCalled()
  })

  it('calls get_batch_properties with the visible block ids', async () => {
    mockedGetBatchProperties.mockResolvedValueOnce({})

    renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }, { id: 'B2' }]))

    await waitFor(() => {
      expect(mockedGetBatchProperties).toHaveBeenCalledWith(['B1', 'B2'])
    })
  })

  it('filters out the four built-in fields (todo_state, priority, due_date, scheduled_date)', async () => {
    // Use `mockResolvedValue` rather than `mockResolvedValueOnce` because
    // the hook re-runs on its own setState (fresh `blocks` reference each
    // render → useEffect re-fires); we need the IPC to keep returning the
    // payload across all settle cycles.
    mockedGetBatchProperties.mockResolvedValue({
      B1: [
        row({ key: 'todo_state', value_text: 'TODO' }),
        row({ key: 'priority', value_num: 1 }),
        row({ key: 'due_date', value_date: '2025-01-01' }),
        row({ key: 'scheduled_date', value_date: '2025-01-02' }),
        row({ key: 'effort', value_text: '2h' }),
      ],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]))

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '2h' }])
    })
  })

  it('flattens typed value fields (text → date → num → empty) and drops empty values', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [
        row({ key: 'note', value_text: 'hello' }),
        row({ key: 'when', value_date: '2025-03-04' }),
        row({ key: 'count', value_num: 42 }),
        row({ key: 'blank' }),
      ],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]))

    await waitFor(() => {
      expect(result.current['B1']).toEqual([
        { key: 'note', value: 'hello' },
        { key: 'when', value: '2025-03-04' },
        { key: 'count', value: '42' },
      ])
    })
  })

  it('preserves separate property arrays per block', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      B1: [row({ key: 'effort', value_text: '1h' })],
      B2: [row({ key: 'assignee', value_text: 'alice' })],
    })

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }, { id: 'B2' }]))

    await waitFor(() => {
      expect(result.current['B1']).toEqual([{ key: 'effort', value: '1h' }])
      expect(result.current['B2']).toEqual([{ key: 'assignee', value: 'alice' }])
    })
  })

  it('logs a warning and keeps the existing map when the IPC rejects', async () => {
    mockedGetBatchProperties.mockRejectedValueOnce(new Error('ipc-fail'))

    const { result } = renderHook(() => useBlockPropertiesBatch([{ id: 'B1' }]))

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'BlockTree',
        'Failed to load batch properties for blocks',
        undefined,
        expect.any(Error),
      )
    })

    expect(result.current).toEqual({})
  })
})
