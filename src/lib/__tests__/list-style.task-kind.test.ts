/**
 * A task is a third list kind (#5691 D3): what a task shows, and the list
 * styles cleared when blocks are made tasks.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stubInvoke } from '@/__tests__/helpers/invoke'
import type { PropertyRow } from '@/lib/bindings'
import { clearListStyles, LIST_STYLE_KEY, shownListStyle } from '@/lib/list-style'

const mockedInvoke = vi.mocked(invoke)

const styled = (value: string): PropertyRow => ({
  key: LIST_STYLE_KEY,
  value_text: value,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
})

const calls = (command: string) => mockedInvoke.mock.calls.filter(([name]) => name === command)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('shownListStyle', () => {
  it('a task shows no list style, whatever it stores', () => {
    expect(shownListStyle('bullet', true)).toBe('none')
    expect(shownListStyle('ordered', true)).toBe('none')
  })

  it('a block with no task shows the style it stores', () => {
    expect(shownListStyle('bullet', false)).toBe('bullet')
    expect(shownListStyle('ordered', false)).toBe('ordered')
    expect(shownListStyle('none', false)).toBe('none')
  })
})

describe('clearListStyles', () => {
  it('reads the blocks once, clears only those that store a list style, and resolves the clears’ refs', async () => {
    const ref = (id: string) => ({ device_id: 'dev1', seq: id === 'A' ? 1 : 2 })
    stubInvoke(mockedInvoke, {
      get_batch_properties: () => ({
        A: [styled('bullet')],
        C: [styled('ordered')],
      }),
      delete_property: (args) => ({
        block_id: args['blockId'] as string,
        key: LIST_STYLE_KEY,
        op_refs: [ref(args['blockId'] as string)],
      }),
    })

    await expect(clearListStyles(['A', 'B', 'C'])).resolves.toEqual([ref('A'), ref('C')])

    expect(calls('get_batch_properties')).toEqual([
      ['get_batch_properties', { blockIds: ['A', 'B', 'C'] }],
    ])
    expect(calls('delete_property').map(([, args]) => args)).toEqual([
      { blockId: 'A', key: LIST_STYLE_KEY },
      { blockId: 'C', key: LIST_STYLE_KEY },
    ])
  })

  it('asks nothing for no blocks', async () => {
    stubInvoke(mockedInvoke, {})
    await expect(clearListStyles([])).resolves.toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('a refused read clears nothing, and says so', async () => {
    stubInvoke(mockedInvoke, {
      get_batch_properties: () => Promise.reject(new Error('refused')),
    })

    await expect(clearListStyles(['A'])).resolves.toEqual([])

    expect(calls('delete_property')).toEqual([])
    expect(vi.mocked(toast.error).mock.calls.map(([message]) => message)).toEqual([
      'Failed to clear list style',
    ])
  })
})
