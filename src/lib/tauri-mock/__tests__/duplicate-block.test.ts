/**
 * #5140 Phase 3a — mock `duplicate_block`. It copies ROWS: the root lands one
 * slot after the original, the content subtree follows in pre-order, a nested
 * page stays behind, and the copy keeps the task columns and every property
 * except the ones that describe the original (space, timestamps, recurrence,
 * template). Everything is read back through the mock's own read commands.
 * Backend parity is pinned by `conformance/fixtures/duplicate_block.json`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PropertyRow } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
const PAGE = id('PAGE')
const A = id('A')
const SRC = id('SRC')
const CHILD = id('CHILD')
const NESTED_PAGE = id('NESTEDPAGE')
const IN_NESTED = id('INNESTED')
const SECOND = id('SECOND')
const GRANDCHILD = id('GRANDCHILD')
const C = id('C')
const TRASHED = id('TRASHED')
const MISSING = id('MISSING')

const SRC_CONTENT = '```\nfirst line\nsecond line\n```'

interface Row {
  id: string
  content: string | null
  parent_id: string | null
  position: number | null
}

function put(
  blockId: string,
  type: string,
  content: string,
  parent: string | null,
  position: number,
  pageId: string | null,
): Record<string, unknown> {
  const row = makeBlock(blockId, type, content, parent, position)
  row['page_id'] = pageId
  blocks.set(blockId, row)
  return row
}

function setProp(blockId: string, key: string, value: Partial<PropertyRow>): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...value,
  })
}

function childrenOf(parentId: string): Row[] {
  const page = dispatch('list_blocks', { request: { parentId, limit: 100 } }) as { items: Row[] }
  return page.items
}

function duplicate(blockId: string): Row[] {
  return (dispatch('duplicate_block', { blockId }) as { blocks: Row[] }).blocks
}

/** The `AppErrorKind` the command refuses with, or `null` when it succeeds. */
function refusal(blockId: string): unknown {
  try {
    dispatch('duplicate_block', { blockId })
  } catch (err) {
    return (err as { kind?: unknown }).kind
  }
  return null
}

describe('tauri-mock duplicate_block', () => {
  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    opLog.length = 0

    put(PAGE, 'page', 'Home', null, 1, PAGE)
    put(A, 'content', 'before', PAGE, 1, PAGE)
    const src = put(SRC, 'content', SRC_CONTENT, PAGE, 2, PAGE)
    put(CHILD, 'content', 'child', SRC, 1, PAGE)
    put(NESTED_PAGE, 'page', 'Nested', SRC, 2, NESTED_PAGE)
    put(IN_NESTED, 'content', 'inside the nested page', NESTED_PAGE, 1, NESTED_PAGE)
    put(SECOND, 'content', 'second child', SRC, 3, PAGE)
    put(GRANDCHILD, 'content', 'grandchild', SECOND, 1, PAGE)
    put(C, 'content', 'after', PAGE, 3, PAGE)
    put(TRASHED, 'content', 'gone', PAGE, 4, PAGE)['deleted_at'] = 1

    Object.assign(src, {
      todo_state: 'DOING',
      priority: '1',
      due_date: '2026-03-01',
      scheduled_date: '2026-02-01',
    })
    setProp(SRC, 'listStyle', { value_text: 'ordered' })
    setProp(SRC, 'colour', { value_text: 'red' })
    setProp(SRC, 'repeatable', { value_text: 'yes' })
    setProp(SRC, 'reviewer', { value_ref: C })
    for (const key of ['space', 'template']) setProp(SRC, key, { value_ref: PAGE })
    for (const key of ['created_at', 'completed_at'])
      setProp(SRC, key, { value_date: '2026-01-01' })
    // #5160 P4 — the rule is copied; one occurrence's bookkeeping is not.
    setProp(SRC, 'repeat', { value_text: '+1w' })
    setProp(SRC, 'repeat-until', { value_date: '2026-12-31' })
    for (const key of ['repeat-seq', 'repeat-origin']) setProp(SRC, key, { value_text: '1' })
  })

  it('lands the root one slot after the original and returns the content subtree in pre-order', () => {
    const created = duplicate(SRC)

    const [copy, copyChild, copySecond, copyGrandchild] = created as [Row, Row, Row, Row]
    expect(created.map((r) => r.content)).toEqual([
      SRC_CONTENT,
      'child',
      'second child',
      'grandchild',
    ])
    expect(created.map((r) => r.parent_id)).toEqual([PAGE, copy.id, copy.id, copySecond.id])

    const page = childrenOf(PAGE)
    expect(page.map((r) => r.id)).toEqual([A, SRC, copy.id, C])
    expect(page.map((r) => r.position)).toEqual([1, 2, 3, 4])
    expect(childrenOf(copy.id).map((r) => r.id)).toEqual([copyChild.id, copySecond.id])
    expect(childrenOf(copySecond.id).map((r) => r.id)).toEqual([copyGrandchild.id])
  })

  it('leaves a nested page and everything under it behind', () => {
    duplicate(SRC)

    const pagesNamedNested = [...blocks.values()].filter((b) => b['content'] === 'Nested')
    expect(pagesNamedNested.map((b) => b['id'])).toEqual([NESTED_PAGE])
    const underNested = [...blocks.values()].filter(
      (b) => b['content'] === 'inside the nested page',
    )
    expect(underNested.map((b) => b['id'])).toEqual([IN_NESTED])
  })

  it('carries the task columns and content properties, not the ones that describe the original', () => {
    const [copy] = duplicate(SRC) as [Row]

    expect(dispatch('get_block', { blockId: copy.id })).toMatchObject({
      todo_state: 'DOING',
      priority: '1',
      due_date: '2026-03-01',
      scheduled_date: '2026-02-01',
    })
    const props = dispatch('get_properties', { blockId: copy.id }) as PropertyRow[]
    expect(
      Object.fromEntries(props.map((p) => [p.key, p.value_text ?? p.value_ref ?? p.value_date])),
    ).toEqual({
      listStyle: 'ordered',
      colour: 'red',
      repeatable: 'yes',
      reviewer: C,
      repeat: '+1w',
      'repeat-until': '2026-12-31',
    })
  })

  it('refuses an unknown id, a page and a trashed block without appending an op', () => {
    expect(refusal(MISSING)).toBe('not_found')
    expect(refusal(PAGE)).toBe('validation')
    expect(refusal(TRASHED)).toBe('validation')
    expect(opLog).toHaveLength(0)
  })
})
