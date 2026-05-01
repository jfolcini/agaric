/**
 * Tests for useBlockPropertyIpc hook — typed wrappers around the
 * getProperties / listPropertyDefs / setProperty IPC trio used by the
 * BlockPropertyDrawer surface.
 *
 * Validates:
 * - getProperties forwards blockId to the get_properties IPC and returns rows
 * - listPropertyDefs invokes list_property_defs with no args and returns the array
 * - setProperty maps the param object to the positional bindings call
 * - errors propagate from the IPC layer (no swallowing)
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockPropertyIpc } from '../useBlockPropertyIpc'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBlockPropertyIpc.getProperties', () => {
  it('invokes get_properties with the block id and returns the rows', async () => {
    const rows = [
      {
        block_id: 'BLOCK_1',
        key: 'effort',
        value_text: '3',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
    ]
    mockedInvoke.mockResolvedValueOnce(rows)

    const { result } = renderHook(() => useBlockPropertyIpc())

    let returned: unknown
    await act(async () => {
      returned = await result.current.getProperties('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: 'BLOCK_1' })
    expect(returned).toEqual(rows)
  })

  it('propagates rejection from the IPC layer', async () => {
    const cause = new Error('IPC failure')
    mockedInvoke.mockRejectedValueOnce(cause)

    const { result } = renderHook(() => useBlockPropertyIpc())

    await expect(
      act(async () => {
        await result.current.getProperties('BLOCK_1')
      }),
    ).rejects.toBe(cause)
  })
})

describe('useBlockPropertyIpc.listPropertyDefs', () => {
  it('invokes list_property_defs with no args and returns the defs array', async () => {
    const defs = [{ key: 'effort', value_type: 'number', label: 'Effort', icon: null }]
    mockedInvoke.mockResolvedValueOnce(defs)

    const { result } = renderHook(() => useBlockPropertyIpc())

    let returned: unknown
    await act(async () => {
      returned = await result.current.listPropertyDefs()
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs')
    expect(returned).toEqual(defs)
  })
})

describe('useBlockPropertyIpc.setProperty', () => {
  it('maps the param object to the positional bindings call (text)', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockPropertyIpc())

    await act(async () => {
      await result.current.setProperty({
        blockId: 'BLOCK_1',
        key: 'effort',
        valueText: '3',
      })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'effort',
      valueText: '3',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
  })

  it('forwards null defaults for unset value fields', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockPropertyIpc())

    await act(async () => {
      await result.current.setProperty({
        blockId: 'BLOCK_1',
        key: 'priority',
        valueNum: 1,
      })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
      valueText: null,
      valueNum: 1,
      valueDate: null,
      valueRef: null,
    })
  })

  it('propagates rejection from the IPC layer', async () => {
    const cause = new Error('write failed')
    mockedInvoke.mockRejectedValueOnce(cause)

    const { result } = renderHook(() => useBlockPropertyIpc())

    await expect(
      act(async () => {
        await result.current.setProperty({
          blockId: 'BLOCK_1',
          key: 'effort',
          valueText: '3',
        })
      }),
    ).rejects.toBe(cause)
  })
})
