/**
 * Tests for usePropertyDefForEdit — loads property definitions when the
 * user starts editing a property, and exposes select / ref UI state.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPropertyDef = vi.fn()
const mockListBlocks = vi.fn()
vi.mock('../../lib/tauri', () => ({
  getPropertyDef: (...args: unknown[]) => mockGetPropertyDef(...args),
  listBlocks: (...args: unknown[]) => mockListBlocks(...args),
}))

const mockLoggerWarn = vi.fn()
vi.mock('../../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import type { BlockRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { usePropertyDefForEdit } from '../usePropertyDefForEdit'

function makePage(id: string, content: string): BlockRow {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    position: null,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // #2248 — reset the active space between tests (the ref-page fetch is
  // gated on it now).
  useSpaceStore.setState({ currentSpaceId: null })
  // Single-key PK lookup; default mock returns null
  // (no def for the requested key).
  mockGetPropertyDef.mockResolvedValue(null)
  mockListBlocks.mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
})

describe('usePropertyDefForEdit', () => {
  it('returns null defaults when editingProp is null', () => {
    const { result } = renderHook(() => usePropertyDefForEdit(null))
    expect(result.current.selectOptions).toBeNull()
    expect(result.current.isRefProp).toBe(false)
    expect(result.current.refPages).toEqual([])
    expect(result.current.refSearch).toBe('')
    expect(mockGetPropertyDef).not.toHaveBeenCalled()
  })

  it('loads select options when value_type is select', async () => {
    mockGetPropertyDef.mockResolvedValue({
      key: 'severity',
      value_type: 'select',
      options: JSON.stringify(['Low', 'Medium', 'High']),
      created_at: '2025-01-01T00:00:00Z',
    })

    const editingProp = { key: 'severity', value: 'Low' }
    const { result } = renderHook(() => usePropertyDefForEdit(editingProp))

    await waitFor(() => {
      expect(result.current.selectOptions).toEqual(['Low', 'Medium', 'High'])
    })
    expect(result.current.isRefProp).toBe(false)
    expect(result.current.refPages).toEqual([])
    // Dedicated PK lookup, not a full vocabulary scan.
    expect(mockGetPropertyDef).toHaveBeenCalledWith('severity')
  })

  it('loads ref pages when value_type is ref', async () => {
    // #2248 — the ref-page fetch requires an active space.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    mockGetPropertyDef.mockResolvedValue({
      key: 'related',
      value_type: 'ref',
      options: null,
      created_at: '2025-01-01T00:00:00Z',
    })
    mockListBlocks.mockResolvedValue({
      items: [makePage('PAGE_1', 'Project A'), makePage('PAGE_2', 'Project B')],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
    // #2248 — the active space is forwarded to `listBlocks` (wrapped into an
    // active SpaceScope inside the wrapper).
    expect(mockListBlocks).toHaveBeenCalledWith({ blockType: 'page', spaceId: 'SPACE_1' })
  })

  it('skips the ref-page fetch and leaves refPages empty when there is no active space (#2248)', async () => {
    // No active space seeded. `listBlocks` has no cross-space form, so the
    // hook must NOT call it and must leave the ref-page list empty.
    mockGetPropertyDef.mockResolvedValue({
      key: 'related',
      value_type: 'ref',
      options: null,
      created_at: '2025-01-01T00:00:00Z',
    })

    const { result } = renderHook(() => usePropertyDefForEdit({ key: 'related', value: '' }))

    await waitFor(() => {
      expect(result.current.isRefProp).toBe(true)
    })
    expect(result.current.refPages).toEqual([])
    expect(mockListBlocks).not.toHaveBeenCalled()
  })

  it('logs a warning and clears state when getPropertyDef rejects', async () => {
    mockGetPropertyDef.mockRejectedValueOnce(new Error('network timeout'))

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
    mockGetPropertyDef.mockResolvedValue({
      key: 'severity',
      value_type: 'select',
      options: JSON.stringify(['Low', 'High']),
      created_at: '2025-01-01T00:00:00Z',
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
