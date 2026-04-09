/**
 * Tests for usePropertySave hook.
 *
 * Validates:
 *  - handleSave calls handleSaveProperty and refreshes property list
 *  - handleSave shows invalidNumber toast when validation fails
 *  - handleSave shows saveFailed toast on error
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
import type { PropertyRow } from '../../lib/tauri'
import { usePropertySave } from '../usePropertySave'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

function makeProp(key: string, overrides?: Partial<PropertyRow>): PropertyRow {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
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
        valueText: 'active',
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

  it('announces on save when announceOnSave is set', async () => {
    const { announce } = await import('../../lib/announcer')
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
    const { announce } = await import('../../lib/announcer')
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
    const { logger } = await import('../../lib/logger')
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
    const { announce } = await import('../../lib/announcer')
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
    const { announce } = await import('../../lib/announcer')
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
    const { logger } = await import('../../lib/logger')
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
    // biome-ignore lint/style/noNonNullAssertion: verified not-null above
    const filtered = capturedUpdater!(prev)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.key).toBe('priority')
  })
})
