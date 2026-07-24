// @vitest-environment jsdom

/**
 * Tests for useListStyles (#3000) — projects the per-block `listStyle` map
 * from the SHARED `BatchPropertiesProvider` batch (mirrors
 * useExtraBlockProperties). Absent listStyle row ⇒ omitted (= 'none').
 */

import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  getBatchProperties: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useListStyles } from '@/hooks/useListStyles'
import { LIST_STYLE_KEY } from '@/lib/list-style'
import type { PropertyRow } from '@/lib/tauri'
import { getBatchProperties } from '@/lib/tauri'

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

function providerWrapper(blockIds: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <BatchPropertiesProvider blockIds={blockIds}>{children}</BatchPropertiesProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetBatchProperties.mockResolvedValue({})
})

describe('useListStyles', () => {
  it('returns an empty map outside a provider', () => {
    const { result } = renderHook(() => useListStyles([{ id: 'A' }]))
    expect(result.current.size).toBe(0)
  })

  it('projects bullet/ordered and omits none (absent) blocks', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      A: [row({ key: LIST_STYLE_KEY, value_text: 'bullet' })],
      B: [row({ key: LIST_STYLE_KEY, value_text: 'ordered' })],
      C: [row({ key: 'other', value_text: 'x' })],
    })
    const { result } = renderHook(() => useListStyles([{ id: 'A' }, { id: 'B' }, { id: 'C' }]), {
      wrapper: providerWrapper(['A', 'B', 'C']),
    })
    await waitFor(() => expect(result.current.get('A')).toBe('bullet'))
    expect(result.current.get('B')).toBe('ordered')
    expect(result.current.has('C')).toBe(false)
  })

  it('keeps a stable map reference across a no-op re-render', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      A: [row({ key: LIST_STYLE_KEY, value_text: 'ordered' })],
    })
    const { result, rerender } = renderHook(() => useListStyles([{ id: 'A' }]), {
      wrapper: providerWrapper(['A']),
    })
    await waitFor(() => expect(result.current.get('A')).toBe('ordered'))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
