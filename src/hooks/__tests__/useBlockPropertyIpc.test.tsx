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

import { paginationLimit } from '@/lib/safe-limit'
import { listPropertyDefs as listPropertyDefsIpc } from '@/lib/tauri'

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
  it('invokes list_property_defs and returns the PageResponse envelope (M-85)', async () => {
    // M-85: `list_property_defs` is now cursor-paginated, so the IPC
    // response shape is `{ items, next_cursor, has_more }`.
    const defs = [{ key: 'effort', value_type: 'number', label: 'Effort', icon: null }]
    const page = { items: defs, next_cursor: null, has_more: false }
    mockedInvoke.mockResolvedValueOnce(page)

    const { result } = renderHook(() => useBlockPropertyIpc())

    let returned: unknown
    await act(async () => {
      returned = await result.current.listPropertyDefs()
    })

    // The wrapper threads `cursor` + `limit` (both null by default) so
    // the bindings call site stays type-safe under the new signature.
    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
      cursor: null,
      limit: null,
    })
    expect(returned).toEqual(page)
  })

  // #976 finding 8 — the single-page happy path above only covers
  // `has_more=false` / `next_cursor=null`. These pin the M-85 pagination
  // contract: a NON-terminal page (`has_more=true` + a `next_cursor`) must be
  // surfaced verbatim so a consumer can detect there are more pages.
  it('surfaces a non-terminal page (has_more=true with next_cursor) verbatim (M-85)', async () => {
    const page = {
      items: [{ key: 'effort', value_type: 'number', label: 'Effort', icon: null }],
      next_cursor: 'cursor-page-2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { result } = renderHook(() => useBlockPropertyIpc())

    let returned: unknown
    await act(async () => {
      returned = await result.current.listPropertyDefs()
    })

    expect(returned).toEqual(page)
  })

  // #976 finding 8 (2) — iterating through cursor-paginated results. The hook
  // exposes a single-page fetch; the cursor continuation lives in the
  // `tauri.ts` wrapper the hook delegates to (`list_property_defs` accepts
  // `cursor`/`limit`). This drives the loop directly against that wrapper with
  // a cursor-conditional `mockImplementation`, asserting both IPC invocations
  // chain the cursor correctly and the loop terminates on `has_more=false`
  // (pattern: UnfinishedTasks.test.tsx).
  it('iterates through paginated results, chaining next_cursor until has_more=false (M-85)', async () => {
    const pageA = {
      items: [{ key: 'effort', value_type: 'number', label: 'Effort', icon: null }],
      next_cursor: 'cursor-2',
      has_more: true,
    }
    const pageB = {
      items: [{ key: 'status', value_type: 'select', label: 'Status', icon: null }],
      next_cursor: null,
      has_more: false,
    }

    // Cursor-conditional: the FIRST page is requested with `cursor: null`; the
    // SECOND with the `next_cursor` the first returned.
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== 'list_property_defs') throw new Error(`unexpected IPC ${cmd}`)
      const cursor = (args as { cursor: string | null }).cursor
      if (cursor === null) return pageA
      if (cursor === 'cursor-2') return pageB
      throw new Error(`unexpected cursor ${String(cursor)}`)
    })

    // Consumer-side iteration loop (what a paginating caller does).
    const limit = paginationLimit(50)
    const collected: unknown[] = []
    let cursor: string | null = null
    do {
      const resp = await listPropertyDefsIpc({ cursor, limit })
      collected.push(...resp.items)
      cursor = resp.has_more ? resp.next_cursor : null
    } while (cursor !== null)

    // Two pages fetched; both items collected in order.
    expect(collected).toEqual([...pageA.items, ...pageB.items])

    // Both IPC invocations chained the cursor correctly.
    const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_property_defs')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual({ cursor: null, limit: 50 })
    expect(calls[1]?.[1]).toEqual({ cursor: 'cursor-2', limit: 50 })
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
      value: {
        value_text: '3',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
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
      value: {
        value_text: null,
        value_num: 1,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
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
