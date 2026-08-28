// @vitest-environment jsdom

/**
 * Tests for useListStyles (#3000) — projects the per-block `listStyle` map
 * from the SHARED `BatchPropertiesProvider` batch (mirrors
 * useExtraBlockProperties). Absent listStyle row ⇒ omitted (= 'none').
 */

import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 4 migrated `useBatchPropertyRows` off the `@/lib/tauri` wrapper
// onto the generated `commands.getBatchProperties`, so mocking only the wrapper
// no longer intercepts. Back the generated surface instead, resolving the same
// typed-result envelope `unwrap` expects.
const mockedGetBatchProperties = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getBatchProperties: (...args: unknown[]) =>
        mockedGetBatchProperties(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useListStyles } from '@/hooks/useListStyles'
import type { PropertyRow } from '@/lib/bindings'
import { LIST_STYLE_KEY } from '@/lib/list-style'

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

  // The test above passes even for the WRONG reason: the render callback
  // recreates `[{ id: 'A' }]` on every call, but `idSignature` is a joined
  // STRING ("A"), a primitive that compares equal by value across renders —
  // so the outer `useMemo`'s dep array never actually changes and React
  // bails out without ever re-invoking the compute-and-compare body at all.
  // A no-op `rerender()` would look identical whether or not the
  // content-equality reuse (#4012, `mapsEqual`/`prevRef`) works or is
  // deleted outright.
  //
  // This test forces a genuine RECOMPUTE — reordering `blocks` changes
  // `idSignature` ("A\0B" -> "B\0A") without touching the batch data — and
  // is exactly the "drag/reorder that does not refetch" case the file's
  // docblock invariant promises. It is the one that would go red if the
  // content-equality reuse were broken.
  it('keeps a stable map reference across a reorder that changes no style (content-equality reuse)', async () => {
    mockedGetBatchProperties.mockResolvedValue({
      A: [row({ key: LIST_STYLE_KEY, value_text: 'bullet' })],
      B: [row({ key: LIST_STYLE_KEY, value_text: 'ordered' })],
    })
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: { id: string }[] }) => useListStyles(blocks),
      {
        initialProps: { blocks: [{ id: 'A' }, { id: 'B' }] },
        wrapper: providerWrapper(['A', 'B']),
      },
    )
    await waitFor(() => expect(result.current.get('A')).toBe('bullet'))
    expect(result.current.get('B')).toBe('ordered')
    const first = result.current

    // Same ids, same styles, reversed order — idSignature changes, so the
    // memo body actually re-runs and recomputes `next` from scratch.
    rerender({ blocks: [{ id: 'B' }, { id: 'A' }] })

    expect(result.current.get('A')).toBe('bullet')
    expect(result.current.get('B')).toBe('ordered')
    expect(result.current).toBe(first)
  })
})
