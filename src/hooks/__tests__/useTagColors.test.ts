/**
 * Tests for useTagColors: a colour lands in localStorage and state at once,
 * closes the picker, and follows to the `color` property best-effort.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { useTagColors } from '@/hooks/useTagColors'
import { logger } from '@/lib/logger'
import { getTagColors } from '@/lib/tag-colors'
import { useResolveStore } from '@/stores/resolve'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('tag-colors')
  useResolveStore.setState({ tagColors: {} })
})

describe('useTagColors', () => {
  it('starts from the stored colours with no picker open', () => {
    localStorage.setItem('tag-colors', JSON.stringify({ T1: 'accent-rose' }))

    const { result } = renderHook(() => useTagColors())

    expect(result.current.tagColors).toEqual({ T1: 'accent-rose' })
    expect(result.current.colorPickerOpen).toBeNull()
  })

  it('setColor stores the colour, closes the picker and writes the property', async () => {
    stubInvoke({ set_property: () => withOps(makeBlockRow({ id: 'T1', block_type: 'tag' })) })
    const { result } = renderHook(() => useTagColors())
    act(() => result.current.setColorPickerOpen('T1'))

    await act(() => result.current.setColor('T1', 'accent-blue'))

    expect(getTagColors()).toEqual({ T1: 'accent-blue' })
    expect(result.current.tagColors).toEqual({ T1: 'accent-blue' })
    expect(result.current.colorPickerOpen).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'T1',
      key: 'color',
      value: {
        value_text: 'accent-blue',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
  })

  it('setColor keeps the local colour and warns when the property write fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    stubInvoke({ set_property: () => Promise.reject(new Error('offline')) })
    const { result } = renderHook(() => useTagColors())

    await act(() => result.current.setColor('T1', '#123456'))

    expect(result.current.tagColors).toEqual({ T1: '#123456' })
    expect(getTagColors()).toEqual({ T1: '#123456' })
    expect(warn).toHaveBeenCalledWith(
      'useTagColors',
      'failed to persist tag color via setProperty',
      { tagId: 'T1', color: '#123456' },
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('clearColor drops the colour, closes the picker and deletes the property', async () => {
    localStorage.setItem('tag-colors', JSON.stringify({ T1: 'accent-rose', T2: 'accent-blue' }))
    stubInvoke({ delete_property: () => withOps({ block_id: 'T1', key: 'color' }) })
    const { result } = renderHook(() => useTagColors())
    act(() => result.current.setColorPickerOpen('T1'))

    await act(() => result.current.clearColor('T1'))

    expect(getTagColors()).toEqual({ T2: 'accent-blue' })
    expect(result.current.tagColors).toEqual({ T2: 'accent-blue' })
    expect(result.current.colorPickerOpen).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', { blockId: 'T1', key: 'color' })
  })

  it('clearColor keeps the colour cleared and warns when the property delete fails', async () => {
    localStorage.setItem('tag-colors', JSON.stringify({ T1: 'accent-rose' }))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    stubInvoke({ delete_property: () => Promise.reject(new Error('offline')) })
    const { result } = renderHook(() => useTagColors())

    await act(() => result.current.clearColor('T1'))

    expect(result.current.tagColors).toEqual({})
    expect(getTagColors()).toEqual({})
    expect(warn).toHaveBeenCalledWith(
      'useTagColors',
      'failed to clear tag color via deleteProperty',
      { tagId: 'T1' },
      expect.any(Error),
    )
    warn.mockRestore()
  })

  describe('synced `color` property (#6544)', () => {
    it('shows the synced colour over the local one, and the local one where none synced', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ T1: 'accent-rose', T2: 'accent-blue' }))
      useResolveStore.setState({ tagColors: { T1: 'accent-violet', T3: 'accent-amber' } })

      const { result } = renderHook(() => useTagColors())

      expect(result.current.tagColors).toEqual({
        T1: 'accent-violet',
        T2: 'accent-blue',
        T3: 'accent-amber',
      })
    })

    it('setColor records the committed colour as the synced one', async () => {
      useResolveStore.setState({ tagColors: { T1: 'accent-violet' } })
      stubInvoke({ set_property: () => withOps(makeBlockRow({ id: 'T1', block_type: 'tag' })) })
      const { result } = renderHook(() => useTagColors())

      await act(() => result.current.setColor('T1', 'accent-blue'))

      expect(useResolveStore.getState().tagColors).toEqual({ T1: 'accent-blue' })
      expect(result.current.tagColors).toEqual({ T1: 'accent-blue' })
    })

    it('setColor leaves the synced colour when the property write fails', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      useResolveStore.setState({ tagColors: { T1: 'accent-violet' } })
      stubInvoke({ set_property: () => Promise.reject(new Error('offline')) })
      const { result } = renderHook(() => useTagColors())

      await act(() => result.current.setColor('T1', 'accent-blue'))

      expect(useResolveStore.getState().tagColors).toEqual({ T1: 'accent-violet' })
      expect(result.current.tagColors).toEqual({ T1: 'accent-violet' })
      vi.mocked(logger.warn).mockRestore()
    })

    it('clearColor drops the synced colour once the delete commits', async () => {
      useResolveStore.setState({ tagColors: { T1: 'accent-violet' } })
      stubInvoke({ delete_property: () => withOps({ block_id: 'T1', key: 'color' }) })
      const { result } = renderHook(() => useTagColors())

      await act(() => result.current.clearColor('T1'))

      expect(useResolveStore.getState().tagColors).toEqual({})
      expect(result.current.tagColors).toEqual({})
    })

    it('clearColor leaves the synced colour when the property delete fails', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      useResolveStore.setState({ tagColors: { T1: 'accent-violet' } })
      stubInvoke({ delete_property: () => Promise.reject(new Error('offline')) })
      const { result } = renderHook(() => useTagColors())

      await act(() => result.current.clearColor('T1'))

      expect(useResolveStore.getState().tagColors).toEqual({ T1: 'accent-violet' })
      expect(result.current.tagColors).toEqual({ T1: 'accent-violet' })
      vi.mocked(logger.warn).mockRestore()
    })
  })
})
