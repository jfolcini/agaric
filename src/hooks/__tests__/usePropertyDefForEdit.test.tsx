/**
 * Tests for usePropertyDefForEdit — loads property definitions when the
 * user starts editing a property, and exposes select / ref UI state.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListPropertyDefs = vi.fn()
const mockListBlocks = vi.fn()
vi.mock('../../lib/tauri', () => ({
  listPropertyDefs: (...args: unknown[]) => mockListPropertyDefs(...args),
  listBlocks: (...args: unknown[]) => mockListBlocks(...args),
}))

const mockLoggerWarn = vi.fn()
vi.mock('../../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import type { BlockRow } from '../../lib/tauri'
import { usePropertyDefForEdit } from '../usePropertyDefForEdit'

function makePage(id: string, content: string): BlockRow {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    position: null,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // M-85: `listPropertyDefs` returns a paginated `PageResponse` envelope.
  mockListPropertyDefs.mockResolvedValue({ items: [], next_cursor: null, has_more: false })
  mockListBlocks.mockResolvedValue({ items: [], next_cursor: null, has_more: false })
})

describe('usePropertyDefForEdit', () => {
  it('returns null defaults when editingProp is null', () => {
    const { result } = renderHook(() => usePropertyDefForEdit(null))
    expect(result.current.selectOptions).toBeNull()
    expect(result.current.isRefProp).toBe(false)
    expect(result.current.refPages).toEqual([])
    expect(result.current.refSearch).toBe('')
    expect(mockListPropertyDefs).not.toHaveBeenCalled()
  })

  it('loads select options when value_type is select', async () => {
    mockListPropertyDefs.mockResolvedValue({
      items: [
        {
          key: 'severity',
          value_type: 'select',
          options: JSON.stringify(['Low', 'Medium', 'High']),
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const editingProp = { key: 'severity', value: 'Low' }
    const { result } = renderHook(() => usePropertyDefForEdit(editingProp))

    await waitFor(() => {
      expect(result.current.selectOptions).toEqual(['Low', 'Medium', 'High'])
    })
    expect(result.current.isRefProp).toBe(false)
    expect(result.current.refPages).toEqual([])
  })

  it('loads ref pages when value_type is ref', async () => {
    mockListPropertyDefs.mockResolvedValue({
      items: [
        {
          key: 'related',
          value_type: 'ref',
          options: null,
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    })
    mockListBlocks.mockResolvedValue({
      items: [makePage('PAGE_1', 'Project A'), makePage('PAGE_2', 'Project B')],
      next_cursor: null,
      has_more: false,
    })

    const editingProp = { key: 'related', value: '' }
    const { result } = renderHook(() => usePropertyDefForEdit(editingProp))

    await waitFor(() => {
      expect(result.current.isRefProp).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.refPages).toHaveLength(2)
    })
    expect(result.current.selectOptions).toBeNull()
    // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`; `''` is the
    // pre-bootstrap fallback when no space is seeded in the test.
    expect(mockListBlocks).toHaveBeenCalledWith({ blockType: 'page', spaceId: '' })
  })

  it('logs a warning and clears state when listPropertyDefs rejects', async () => {
    mockListPropertyDefs.mockRejectedValueOnce(new Error('network timeout'))

    const { result } = renderHook(() => usePropertyDefForEdit({ key: 'status', value: 'open' }))

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })
    expect(result.current.selectOptions).toBeNull()
    expect(result.current.isRefProp).toBe(false)

    const [scope, message] = mockLoggerWarn.mock.calls[0] as [string, string]
    expect(scope).toBe('SortableBlock')
    expect(message).toBe('property def resolution failed')
  })

  it('resets state when editingProp transitions back to null', async () => {
    mockListPropertyDefs.mockResolvedValue({
      items: [
        {
          key: 'severity',
          value_type: 'select',
          options: JSON.stringify(['Low', 'High']),
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    const editingProp: { key: string; value: string } = { key: 'severity', value: 'Low' }
    const { result, rerender } = renderHook(
      ({ prop }: { prop: { key: string; value: string } | null }) => usePropertyDefForEdit(prop),
      { initialProps: { prop: editingProp as { key: string; value: string } | null } },
    )

    await waitFor(() => {
      expect(result.current.selectOptions).toEqual(['Low', 'High'])
    })

    // Stage a non-empty refSearch to confirm it gets cleared too
    act(() => {
      result.current.setRefSearch('hello')
    })
    expect(result.current.refSearch).toBe('hello')

    rerender({ prop: null })

    await waitFor(() => {
      expect(result.current.selectOptions).toBeNull()
    })
    expect(result.current.isRefProp).toBe(false)
    expect(result.current.refPages).toEqual([])
    expect(result.current.refSearch).toBe('')
  })
})
