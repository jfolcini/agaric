/**
 * What keeps a page out of page mode (#5691): more blocks than its cap. Its
 * blocks' properties and attachments, read with one IPC each, are what page
 * mode draws of them.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  blockerIn,
  blockerMessage,
  PAGE_MODE_BLOCK_CAP,
  readPageFit,
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
  it('keeps a page over the cap out, counting the blocks the store did not load', () => {
    expect(blockerIn(PAGE_MODE_BLOCK_CAP + 1)).toEqual({
      kind: 'overCap',
      count: PAGE_MODE_BLOCK_CAP + 1,
    })
    expect(blockerIn(PAGE_MODE_BLOCK_CAP)).toBeNull()
  })

  describe('the cap the perf harness raises', () => {
    const harness = window as { __pageModeBlockCap?: unknown }
    afterEach(() => {
      vi.unstubAllEnvs()
      delete harness.__pageModeBlockCap
    })

    it('is raised in the e2e build only, and only by a number', () => {
      harness.__pageModeBlockCap = 2
      expect(blockerIn(3)).toBeNull()
      vi.stubEnv('VITE_E2E', 'true')
      expect(blockerIn(3)).toEqual({ kind: 'overCap', count: 3 })
      expect(blockerIn(2)).toBeNull()
      harness.__pageModeBlockCap = '2'
      expect(blockerIn(3)).toBeNull()
    })
  })
})

describe('readPageFit', () => {
  it('reads the properties and attachments of every block, once each', async () => {
    const getBatchProperties = vi.fn(() => ({}))
    const listAttachmentsBatch = vi.fn(() => ({}))
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: getBatchProperties,
        list_attachments_batch: listAttachmentsBatch,
      }),
    )

    expect((await readPageFit([row(), row({ id: 'B2' })], 2)).blocker).toBeNull()
    expect(getBatchProperties).toHaveBeenCalledWith({ blockIds: ['B1', 'B2'] })
    expect(listAttachmentsBatch).toHaveBeenCalledWith({ blockIds: ['B1', 'B2'] })
  })

  it('lets in a task whose only properties are the stamps its state wrote', async () => {
    const stamp = (key: string) => ({
      ...property,
      key,
      value_text: null,
      value_date: '2026-10-18',
    })
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => ({ B1: [stamp('created_at'), stamp('completed_at')] }),
        list_attachments_batch: () => ({}),
      }),
    )

    expect((await readPageFit([row({ todo_state: 'DONE' })], 1)).blocker).toBeNull()
  })

  it('lets in query and embed blocks, and reads theirs too (#5743)', async () => {
    const getBatchProperties = vi.fn(() => ({}))
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: getBatchProperties,
        list_attachments_batch: () => ({}),
      }),
    )
    const blocks = [
      row({ content: '{{query todo:TODO}}' }),
      row({ id: 'B2', content: '{{embed ((01JAAAAAAAAAAAAAAAAAAAAAAA))}}' }),
      row({ id: 'B3', content: '{{embed [[01JAAAAAAAAAAAAAAAAAAAAAAA]]}}' }),
    ]

    expect((await readPageFit(blocks, 3)).blocker).toBeNull()
    expect(getBatchProperties).toHaveBeenCalledWith({ blockIds: ['B1', 'B2', 'B3'] })
  })

  it('lets in the user’s properties and a repeating task’s rule, and hands them over (#5743)', async () => {
    const rule = { ...property, key: 'repeat', value_text: '+1w' }
    const rows = { B1: [rule], B2: [property] }
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => rows,
        list_attachments_batch: () => ({}),
      }),
    )

    const repeating = row({ todo_state: 'TODO', priority: '2', due_date: '2026-10-20' })
    expect(await readPageFit([repeating, row({ id: 'B2' })], 2)).toEqual({
      blocker: null,
      properties: rows,
      attachments: {},
    })
  })

  it('lets in bullet and numbered blocks, and hands their styles over (#5743)', async () => {
    const listStyle = (value: string) => ({ ...property, key: 'listStyle', value_text: value })
    const rows = { B1: [property, listStyle('bullet')], B2: [listStyle('ordered')] }
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => rows,
        list_attachments_batch: () => ({}),
      }),
    )

    expect(await readPageFit([row(), row({ id: 'B2' })], 2)).toEqual({
      blocker: null,
      properties: rows,
      attachments: {},
    })
  })

  it('lets in blocks with attachments, and hands them over (#5743)', async () => {
    const attachments = {
      B1: [
        {
          id: 'ATT1',
          block_id: 'B1',
          filename: 'a.png',
          mime_type: 'image/png',
          size_bytes: 1,
          fs_path: 'a.png',
          created_at: 0,
          content_hash: null,
        },
      ],
    }
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_batch_properties: () => ({ B1: [] }),
        list_attachments_batch: () => attachments,
      }),
    )

    expect(await readPageFit([row(), row({ id: 'B2' })], 2)).toEqual({
      blocker: null,
      properties: { B1: [] },
      attachments,
    })
  })

  it('asks nothing of an empty page, or of one over the cap', async () => {
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({}))

    expect(await readPageFit([], 0)).toEqual({ blocker: null, properties: {}, attachments: {} })
    expect(await readPageFit([row()], PAGE_MODE_BLOCK_CAP + 1)).toEqual({
      blocker: { kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 },
      properties: {},
      attachments: {},
    })
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

    await expect(readPageFit([row()], 1)).rejects.toThrow()
  })
})

it('blockerMessage says why in a sentence', () => {
  expect(blockerMessage({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 })).toBe(
    t('pageMode.blocked.overCap', { cap: PAGE_MODE_BLOCK_CAP, blocks: PAGE_MODE_BLOCK_CAP + 1 }),
  )
})
