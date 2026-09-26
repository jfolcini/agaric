/**
 * #5160 Phase 4b — the block editor's typed `key:: value` lines, committed
 * against the REAL tauri-mock dispatch and read back from it: a key in another
 * spelling lands on the reserved key or definition it folds to (D13), the
 * recurrence rule is a property line (P4), and a value that cannot be stored
 * stays as text with one toast naming it (D11).
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { bumpFlushSeq, commitInlineProperties } from '@/lib/inline-property-commit'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const BLOCK = SEED_IDS.BLOCK_GS_1

async function commit(content: string) {
  const edit = vi.fn<(blockId: string, content: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  )
  await commitInlineProperties({
    blockId: BLOCK,
    content,
    inlineProps: parseInlineProperties(content),
    mySeq: bumpFlushSeq(BLOCK),
    edit,
    rootParentId: null,
  })
  return edit
}

function stored(): { row: BlockRow; properties: PropertyRow[] } {
  return {
    row: dispatch('get_block', { blockId: BLOCK }) as BlockRow,
    properties: dispatch('get_properties', { blockId: BLOCK }) as PropertyRow[],
  }
}

describe('commitInlineProperties (#5160 Phase 4b)', () => {
  beforeEach(() => {
    seedBlocks()
    vi.clearAllMocks()
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      dispatch(cmd, args),
    )
  })

  // `repeat_until` is already folded, yet names `repeat-until`: a key with no
  // definition spelled so still needs the definitions listed.
  it('a key typed in another case or with `-` lands on the key it folds to (D13)', async () => {
    const edit = await commit(
      'task\nPriority:: 1\nConText:: @home\nrepeat_until:: 2026-12-31\ndue:: 2026-06-01',
    )

    expect(edit).toHaveBeenCalledExactlyOnceWith(BLOCK, 'task')
    const { row, properties } = stored()
    expect(row.priority).toBe('1')
    expect(properties.map((p) => [p.key, p.value_text ?? p.value_date])).toEqual(
      expect.arrayContaining([
        ['context', '@home'],
        ['repeat-until', '2026-12-31'],
        ['due', '2026-06-01'],
      ]),
    )
    expect(properties.map((p) => p.key)).not.toContain('ConText')
    expect(row.due_date).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a value the seeded `due` date definition refuses stays as text, as in the app', async () => {
    const edit = await commit('task\ndue:: soon')

    expect(edit).toHaveBeenCalledExactlyOnceWith(BLOCK, 'task\ndue:: soon')
    expect(stored().properties.map((p) => p.key)).not.toContain('due')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Kept as text: due:: soon')
  })

  it('a ref value names a page by title or `[[id]]`, and one naming none stays text (D11)', async () => {
    for (const key of ['owner', 'approver', 'watcher']) {
      dispatch('create_property_def', { key, valueType: 'ref', options: null })
    }

    const edit = await commit(
      `task\nowner:: getting started\napprover:: [[${SEED_IDS.PAGE_QUICK_NOTES}]]\nwatcher:: Nobody`,
    )

    expect(edit).toHaveBeenCalledExactlyOnceWith(BLOCK, 'task\nwatcher:: Nobody')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Kept as text: watcher:: Nobody')
    expect(stored().properties.map((p) => [p.key, p.value_ref])).toEqual(
      expect.arrayContaining([
        ['owner', SEED_IDS.PAGE_GETTING_STARTED],
        ['approver', SEED_IDS.PAGE_QUICK_NOTES],
      ]),
    )
  })

  it('lists the definitions once per save, however many new keys it holds (D13)', async () => {
    await commit('task\nmood:: calm\nenergy:: high')

    const listings = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'list_property_defs')
    expect(listings).toHaveLength(1)
    expect(stored().properties.map((p) => p.key)).toEqual(
      expect.arrayContaining(['mood', 'energy']),
    )
  })

  it('a typed recurrence rule is a property (P4)', async () => {
    await commit('task\nrepeat:: +1w')

    expect(stored().properties.find((p) => p.key === 'repeat')?.value_text).toBe('+1w')
  })

  it('a value that cannot be stored stays as text, and one toast names it (D11)', async () => {
    dispatch('create_property_def', { key: 'estimate', valueType: 'number', options: null })

    const edit = await commit('task\nproject:: delta\nEstimate:: lots\ncontext:: @desk')

    expect(edit).toHaveBeenCalledExactlyOnceWith(BLOCK, 'task\nproject:: delta\nEstimate:: lots')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Kept as text: project:: delta, Estimate:: lots',
    )
    const keys = stored().properties.map((p) => p.key)
    expect(keys).toContain('context')
    expect(keys).not.toContain('estimate')
  })

  it('a key that folds to two definitions names neither and stays as typed (D13)', async () => {
    dispatch('create_property_def', { key: 'due-date', valueType: 'text', options: null })

    const edit = await commit('task\nDue-Date:: soon')

    expect(edit).toHaveBeenCalledExactlyOnceWith(BLOCK, 'task')
    const { row, properties } = stored()
    expect(properties.map((p) => [p.key, p.value_text])).toContainEqual(['Due-Date', 'soon'])
    expect(row.due_date).toBeNull()
  })
})
