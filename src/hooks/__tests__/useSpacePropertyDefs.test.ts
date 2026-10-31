/**
 * #6206 — the active space's property definitions, by key, read once and
 * shared by every mark on a value that doesn't fit.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { useSpacePropertyDefs } from '@/hooks/useSpacePropertyDefs'
import type { PageResponse, PropertyDefinition } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

function def(key: string, options: string | null): PropertyDefinition {
  return { key, value_type: 'select', options, created_at: '2026-01-01', builtin: false }
}

let stored: PropertyDefinition[] = []

function defsPage(): PageResponse<PropertyDefinition> {
  return { items: stored, next_cursor: null, has_more: false, total_count: null }
}

function callsOf(command: string): number {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === command).length
}

beforeEach(() => {
  vi.clearAllMocks()
  stored = [def('project', '["alpha"]')]
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  mockedInvoke.mockImplementation(mockInvokeCommands({ list_property_defs: defsPage }))
})

describe('useSpacePropertyDefs (#6206)', () => {
  it("answers the active space's definitions by key", async () => {
    const { result } = renderHook(() => useSpacePropertyDefs())

    await waitFor(() => {
      expect(result.current?.get('project')).toEqual(def('project', '["alpha"]'))
    })
    expect(result.current?.size).toBe(1)
    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
      spaceId: 'SPACE_1',
      cursor: null,
      limit: null,
    })
  })

  it('warns and answers nothing when the definitions fail to load', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_property_defs: () => Promise.reject(new Error('defs failed')),
      }),
    )
    const { result } = renderHook(() => useSpacePropertyDefs())

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
    })
    expect(result.current).toBeUndefined()
  })

  it('asks for nothing without an active space', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    const { result } = renderHook(() => useSpacePropertyDefs())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current).toBeUndefined()
    expect(callsOf('list_property_defs')).toBe(0)
  })

  it('reads them again after invalidatePropertyCaches()', async () => {
    const { result } = renderHook(() => useSpacePropertyDefs())
    await waitFor(() => {
      expect(result.current?.get('project')?.options).toBe('["alpha"]')
    })

    stored = [def('project', '["alpha","beta"]')]
    act(() => {
      invalidatePropertyCaches()
    })

    await waitFor(() => {
      expect(result.current?.get('project')?.options).toBe('["alpha","beta"]')
    })
    expect(callsOf('list_property_defs')).toBe(2)
  })
})
