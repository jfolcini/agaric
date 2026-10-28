// A list marker is only for a bullet or numbered block: a list block whose text
// this device's `edit` stops opening with a paragraph leaves the list, once the
// text is saved. A change that reaches the store through `load()` (a sync, MCP,
// a page-level undo) clears nothing.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyRow } from '@/lib/bindings'
import { listStyleFromRows, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/stores/undo', () => ({
  useUndoStore: { getState: () => ({ onNewAction: vi.fn(), clearPage: vi.fn() }) },
}))

const mockedInvoke = vi.mocked(invoke)
const ITEM = SEED_IDS.BLOCK_GS_1
const OTHER = SEED_IDS.BLOCK_GS_2

const styleOf = (blockId: string) =>
  listStyleFromRows(dispatch('get_properties', { blockId }) as PropertyRow[])
const called = (cmd: string) => mockedInvoke.mock.calls.map(([c]) => c).indexOf(cmd)

async function openPage() {
  const store = createPageBlockStore(SEED_IDS.PAGE_GETTING_STARTED)
  await store.getState().load()
  return store
}

beforeEach(async () => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  dispatch('edit_block', { blockId: ITEM, toText: 'item' })
  await setListStyle(ITEM, 'bullet')
})

describe('edit — a list block that stops opening with a paragraph', () => {
  it.each([
    ['a heading', '# item'],
    ['a code block', '```\nitem\n```'],
    ['a divider', '---'],
    ['a query', '{{query tag:work}}'],
  ])('leaves the list once its text, become %s, is saved', async (_kind, next) => {
    const store = await openPage()

    expect(await store.getState().edit(ITEM, next)).toBe(true)

    expect(styleOf(ITEM)).toBe('none')
    expect(called('delete_property')).toBeGreaterThan(called('edit_block'))
  })

  it('keeps the style while its text stays a paragraph, and on a block that never opened with one', async () => {
    dispatch('edit_block', { blockId: OTHER, toText: '# Title' })
    await setListStyle(OTHER, 'bullet')
    const store = await openPage()

    await store.getState().edit(ITEM, 'item, edited')
    await store.getState().edit(OTHER, '# Title, edited')
    await store.getState().edit(OTHER, '```\ncode\n```')

    expect([styleOf(ITEM), styleOf(OTHER)]).toEqual(['bullet', 'bullet'])
    expect(called('delete_property')).toBe(-1)
  })

  it('keeps the style when the backend refuses the edit', async () => {
    const store = await openPage()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    expect(await store.getState().edit(ITEM, '# item')).toBe(false)

    expect(store.getState().blocksById.get(ITEM)?.content).toBe('item')
    expect(styleOf(ITEM)).toBe('bullet')
    expect(called('delete_property')).toBe(-1)
  })

  it('logs a refused clear, and the edit stands', async () => {
    const store = await openPage()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'delete_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await store.getState().edit(ITEM, '# item')).toBe(true)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.getState().blocksById.get(ITEM)?.content).toBe('# item')
    expect(styleOf(ITEM)).toBe('bullet')
  })

  it('clears nothing when a reload brings the heading in (a sync, MCP, an undo)', async () => {
    const store = await openPage()
    dispatch('edit_block', { blockId: ITEM, toText: '# item' })

    await store.getState().load()

    expect(store.getState().blocksById.get(ITEM)?.content).toBe('# item')
    expect(styleOf(ITEM)).toBe('bullet')
    expect(called('delete_property')).toBe(-1)
  })
})
