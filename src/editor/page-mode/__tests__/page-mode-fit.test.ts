/**
 * What keeps a page out of page mode (#5691): what its rows hold, read at
 * once, and its blocks' properties and attachments, read with one IPC each.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  blockerIn,
  blockerMessage,
  PAGE_MODE_BLOCK_CAP,
  pageModeBlocker,
} from '@/editor/page-mode/page-mode-fit'
import { t } from '@/lib/i18n'
import type { FlatBlock } from '@/lib/tree-utils'

function row(fields: Partial<FlatBlock> = {}): FlatBlock {
  return { ...makeBlock({ id: 'B1', content: 'text', parent_id: 'PAGE' }), depth: 0, ...fields }
}

const property = {
  key: 'effort',
  value_text: '1h',
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('blockerIn', () => {
  it('keeps a page of plain text, headings, code and links in page mode', () => {
    const blocks = [
      row({ content: 'text' }),
      row({ id: 'B2', content: '# heading' }),
      row({ id: 'B3', content: '```js\nx\n```' }),
      row({ id: 'B4', content: 'see [[01JAAAAAAAAAAAAAAAAAAAAAAA]]' }),
    ]

    expect(blockerIn(blocks, blocks.length)).toBeNull()
  })

  it.each([
    ['tasks', { todo_state: 'TODO' }],
    ['priorities', { priority: '1' }],
    ['dates', { due_date: '2026-10-20' }],
    ['dates', { scheduled_date: '2026-10-20' }],
    ['queries', { content: '{{query todo:TODO}}' }],
    ['embeds', { content: '{{embed ((01JAAAAAAAAAAAAAAAAAAAAAAA))}}' }],
  ] as const)('keeps a page holding %s out', (kind, fields) => {
    expect(blockerIn([row(), row({ id: 'B2', ...fields })], 2)).toEqual({ kind })
  })

  it('keeps a page over the cap out, counting the blocks the store did not load', () => {
    expect(blockerIn([row()], PAGE_MODE_BLOCK_CAP + 1)).toEqual({
      kind: 'overCap',
      count: PAGE_MODE_BLOCK_CAP + 1,
    })
    expect(blockerIn([row()], PAGE_MODE_BLOCK_CAP)).toBeNull()
  })
})

describe('pageModeBlocker', () => {
  it('reads the properties and attachments of every block, once each', async () => {
    const getBatchProperties = vi.fn(() => ({}))
    const listAttachmentsBatch = vi.fn(() => ({}))
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: getBatchProperties,
        list_attachments_batch: listAttachmentsBatch,
      }),
    )

    expect(await pageModeBlocker([row(), row({ id: 'B2' })], 2)).toBeNull()
    expect(getBatchProperties).toHaveBeenCalledWith({ blockIds: ['B1', 'B2'] })
    expect(listAttachmentsBatch).toHaveBeenCalledWith({ blockIds: ['B1', 'B2'] })
  })

  it('keeps out a page whose block holds a property, or an attachment', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => ({ B1: [property] }),
        list_attachments_batch: () => ({}),
      }),
    )
    expect(await pageModeBlocker([row()], 1)).toEqual({ kind: 'properties' })

    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => ({ B1: [] }),
        list_attachments_batch: () => ({
          B1: [
            {
              id: 'ATT1',
              block_id: 'B1',
              filename: 'a.png',
              mime_type: 'image/png',
              size_bytes: 1,
              fs_path: 'a.png',
              created_at: 0,
            },
          ],
        }),
      }),
    )
    expect(await pageModeBlocker([row()], 1)).toEqual({ kind: 'attachments' })
  })

  it('asks nothing of an empty page, or of one its rows already keep out', async () => {
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({}))

    expect(await pageModeBlocker([], 0)).toBeNull()
    expect(await pageModeBlocker([row({ todo_state: 'DONE' })], 1)).toEqual({ kind: 'tasks' })
  })

  it('rejects when a read fails, so the caller keeps the page in block mode', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => {
          throw new Error('database locked')
        },
        list_attachments_batch: () => ({}),
      }),
    )

    await expect(pageModeBlocker([row()], 1)).rejects.toThrow()
  })
})

it('blockerMessage says why in a sentence', () => {
  expect(blockerMessage({ kind: 'tasks' })).toBe(t('pageMode.blocked.tasks'))
  expect(blockerMessage({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 })).toBe(
    t('pageMode.blocked.overCap', { cap: PAGE_MODE_BLOCK_CAP, blocks: PAGE_MODE_BLOCK_CAP + 1 }),
  )
})
