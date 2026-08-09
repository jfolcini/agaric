/**
 * Tests for usePropertySave hook.
 *
 * Validates:
 *  - handleSave calls handleSaveProperty and refreshes property list
 *  - handleSave shows invalidNumber toast when validation fails
 *  - handleSave shows saveFailed toast on error
 *  - handleSave surfaces a coded InvalidRepeatRule reason verbatim (#3647)
 *  - handleSave announces on success when announceOnSave is set
 *  - handleSave logs errors when logTag is set
 *  - handleDelete calls handleDeleteProperty and removes from list
 *  - handleDelete shows deleteFailed toast on error
 *  - handleDelete announces on success when announceOnDelete is set
 *  - No-ops when blockId is null
 *  - Supports custom toast keys
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePropertySave } from '@/hooks/usePropertySave'
import type { PropertyRow } from '@/lib/tauri'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

function makeProp(key: string, overrides?: Partial<PropertyRow>): PropertyRow {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePropertySave handleSave', () => {
  it('calls setProperty and refreshes property list on success', async () => {
    const updatedProps = [makeProp('status', { value_text: 'active' })]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return updatedProps
      return null
    })

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('status', 'active', 'text')
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'status',
        value: expect.objectContaining({ value_text: 'active' }),
      }),
    )
    expect(setProperties).toHaveBeenCalledWith(updatedProps)
  })

  it('shows invalidNumber toast when number validation fails', async () => {
    mockedInvoke.mockImplementation(async () => null)

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('priority', 'abc', 'number')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Invalid number value')
  })

  it('shows saveFailed toast on error', async () => {
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('status', 'val', 'text')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to save property')
  })

  // #3647 — the backend validates the `repeat` recurrence grammar at
  // `set_property` and ships the reason as a CODED validation error
  // (`InvalidRepeatRule`). Collapsing that into the generic toast would leave
  // the user exactly as uninformed as the silent misbehaviour the validation
  // replaced, so the reason must reach the toast verbatim.
  it('surfaces the backend reason verbatim for a malformed repeat rule (#3647)', async () => {
    mockedInvoke.mockRejectedValue(
      Object.assign(new Error('rejected'), {
        kind: 'validation',
        code: 'InvalidRepeatRule',
        message:
          "repeat rule '++ 1d' is not valid: it contains a space — write `++1d`, not `++ 1d`",
      }),
    )

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('repeat', '++ 1d', 'text')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "repeat rule '++ 1d' is not valid: it contains a space — write `++1d`, not `++ 1d`",
    )
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith('Failed to save property')
  })

  // Only the coded repeat rejection is special-cased: any other validation
  // failure keeps the established generic copy.
  it('keeps the generic toast for an uncoded validation failure (#3647)', async () => {
    mockedInvoke.mockRejectedValue(
      Object.assign(new Error('rejected'), {
        kind: 'validation',
        message: 'set_property.value_text.empty',
      }),
    )

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('status', 'val', 'text')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to save property')
  })

  it('announces on save when announceOnSave is set', async () => {
    const { announce } = await import('@/lib/announcer')
    const updatedProps = [makeProp('status', { value_text: 'done' })]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return updatedProps
      return null
    })

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        announceOnSave: 'property.saved',
      }),
    )

    await act(async () => {
      await result.current.handleSave('status', 'done', 'text')
    })

    expect(vi.mocked(announce)).toHaveBeenCalledWith('Property saved')
  })

  it('does not announce when announceOnSave is not set', async () => {
    const { announce } = await import('@/lib/announcer')
    const updatedProps = [makeProp('status', { value_text: 'done' })]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return updatedProps
      return null
    })

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleSave('status', 'done', 'text')
    })

    expect(vi.mocked(announce)).not.toHaveBeenCalled()
  })

  it('logs errors when logTag is set', async () => {
    const { logger } = await import('@/lib/logger')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        logTag: 'TestComponent',
      }),
    )

    await act(async () => {
      await result.current.handleSave('status', 'val', 'text')
    })

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'TestComponent',
      'Failed to save property',
      expect.objectContaining({ blockId: 'BLOCK_1', key: 'status' }),
      expect.any(Error),
    )
  })

  it('is a no-op when blockId is null', async () => {
    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: null, setProperties }))

    await act(async () => {
      await result.current.handleSave('status', 'val', 'text')
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(setProperties).not.toHaveBeenCalled()
  })

  it('supports custom toast keys', async () => {
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        toasts: { saveFailed: 'pageProperty.saveFailed' },
      }),
    )

    await act(async () => {
      await result.current.handleSave('status', 'val', 'text')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to save property')
  })
})

describe('usePropertySave handleDelete', () => {
  it('calls deleteProperty and removes from list', async () => {
    mockedInvoke.mockResolvedValue(undefined)

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'status',
    })
    // setProperties should be called with the filter function
    expect(setProperties).toHaveBeenCalled()
  })

  it('shows deleteFailed toast on error', async () => {
    mockedInvoke.mockRejectedValue(new Error('delete error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to delete property')
  })

  it('announces on delete when announceOnDelete is set', async () => {
    const { announce } = await import('@/lib/announcer')
    mockedInvoke.mockResolvedValue(undefined)

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        announceOnDelete: 'property.deleted',
      }),
    )

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(vi.mocked(announce)).toHaveBeenCalledWith('Property deleted')
  })

  it('does not announce when announceOnDelete is not set', async () => {
    const { announce } = await import('@/lib/announcer')
    mockedInvoke.mockResolvedValue(undefined)

    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(vi.mocked(announce)).not.toHaveBeenCalled()
  })

  it('is a no-op when blockId is null', async () => {
    const setProperties = vi.fn()
    const { result } = renderHook(() => usePropertySave({ blockId: null, setProperties }))

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(setProperties).not.toHaveBeenCalled()
  })

  it('logs errors when logTag is set', async () => {
    const { logger } = await import('@/lib/logger')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(new Error('delete error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        logTag: 'TestComponent',
      }),
    )

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'TestComponent',
      'Failed to delete property',
      expect.objectContaining({ blockId: 'BLOCK_1', key: 'status' }),
      expect.any(Error),
    )
  })

  it('supports custom deleteFailed toast key', async () => {
    mockedInvoke.mockRejectedValue(new Error('delete error'))

    const setProperties = vi.fn()
    const { result } = renderHook(() =>
      usePropertySave({
        blockId: 'BLOCK_1',
        setProperties,
        toasts: { deleteFailed: 'pageProperty.deleteFailed' },
      }),
    )

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to delete property')
  })

  it('filter function removes the deleted key from the list', async () => {
    mockedInvoke.mockResolvedValue(undefined)

    let capturedUpdater: ((prev: PropertyRow[]) => PropertyRow[]) | null = null
    const setProperties = vi.fn((updater) => {
      if (typeof updater === 'function') {
        capturedUpdater = updater
      }
    })

    const { result } = renderHook(() => usePropertySave({ blockId: 'BLOCK_1', setProperties }))

    await act(async () => {
      await result.current.handleDelete('status')
    })

    expect(capturedUpdater).not.toBeNull()
    const prev = [
      makeProp('status', { value_text: 'active' }),
      makeProp('priority', { value_num: 1 }),
    ]
    // oxlint-disable-next-line typescript/no-non-null-assertion -- verified not-null above; capturedUpdater is assigned only inside an act() closure that TS flow-analysis can't see through, so a guard narrows to `never`
    const filtered = capturedUpdater!(prev)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.key).toBe('priority')
  })
})
