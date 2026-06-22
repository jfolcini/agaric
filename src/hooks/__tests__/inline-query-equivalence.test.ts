/**
 * Legacy ↔ rich EQUIVALENCE harness (P2 full reroute).
 *
 * Every faithfully-translatable inline `{{query}}` shape must return the SAME
 * set of blocks whether executed via the legacy per-type IPCs (`dispatchQuery`)
 * or via the rich `run_advanced_query` engine (`resolveLegacyQueryToFilterExpr`
 * → `fetchRichInlineQuery`). This drives a battery of queries through BOTH paths
 * over one seeded mock dataset and asserts identical result-id sets — the
 * faithfulness gate for the reroute. The mock is conformance-pinned to the real
 * backend, so equivalence here ⇒ equivalence in production.
 *
 * `invoke` is routed to the real mock `dispatch`, so both paths read the same
 * seeded store (no per-command stubbing).
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resolveLegacyQueryToFilterExpr,
  type InlineQueryResolveDeps,
} from '../../lib/inline-query-resolve'
import { parseQueryExpression } from '../../lib/query-utils'
import { listTagsByPrefix } from '../../lib/tauri'
import { dispatch } from '../../lib/tauri-mock/handlers'
import {
  blockTagRefs,
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '../../lib/tauri-mock/seed'
import { dispatchQuery, fetchRichInlineQuery } from '../useQueryExecution'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const SPACE = 'SPACE_EQ'.padStart(26, '0')
const OTHER_SPACE = 'SPACE_OTH'.padStart(26, '0')

function id(label: string): string {
  return label.padStart(26, '0')
}

const PAGE = id('PAGE')
const PAGE_OTHER = id('PAGEOTH')
const TAG_WORK = id('TAGWORK')
const B1 = id('B1') // priority 1, todo TODO, tag work
const B2 = id('B2') // custom: context=@office
const B3 = id('B3') // tag work, due_date 2025-06-01
const B4 = id('B4') // custom: project=beta
const B5 = id('B5') // todo DONE
const B6 = id('B6') // custom date: deadline=2025-06-01
const B7 = id('B7') // tagged work ONLY via an inline block_tag_refs reference
const B8 = id('B8') // custom: context=beta (present, == beta)
const BX = id('BX') // OTHER space — must never appear

function clearMock(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  blockTags.clear()
  blockTagRefs.clear()
  propertyDefs.clear()
  opLog.length = 0
}

function setProp(blockId: string, key: string, value: Record<string, unknown>): void {
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

/** Insert a child block of PAGE with optional row fields. */
function childBlock(
  blockId: string,
  pageId: string,
  fields: Partial<Record<'priority' | 'todo_state' | 'due_date' | 'scheduled_date', string>>,
): void {
  const b = makeBlock(blockId, 'text', `block ${blockId}`, pageId, 1)
  b['page_id'] = pageId
  for (const [k, v] of Object.entries(fields)) b[k] = v
  blocks.set(blockId, b)
}

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(
    async (cmd: string, args?: unknown) => dispatch(cmd, args) as never,
  )
  clearMock()

  // Two pages in two spaces.
  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 1))
  setProp(PAGE, 'space', { value_ref: SPACE })
  blocks.set(PAGE_OTHER, makeBlock(PAGE_OTHER, 'page', 'Other', null, 1))
  setProp(PAGE_OTHER, 'space', { value_ref: OTHER_SPACE })

  // A tag named "work".
  blocks.set(TAG_WORK, makeBlock(TAG_WORK, 'tag', 'work', null, 1))

  childBlock(B1, PAGE, { priority: '1', todo_state: 'TODO' })
  childBlock(B2, PAGE, {})
  setProp(B2, 'context', { value_text: '@office' })
  childBlock(B3, PAGE, { due_date: '2025-06-01' })
  childBlock(B4, PAGE, {})
  setProp(B4, 'project', { value_text: 'beta' })
  childBlock(B5, PAGE, { todo_state: 'DONE' })
  childBlock(B6, PAGE, {})
  setProp(B6, 'deadline', { value_date: '2025-06-01' })
  childBlock(B7, PAGE, {})
  childBlock(B8, PAGE, {})
  setProp(B8, 'context', { value_text: 'beta' }) // present but == beta (excluded by !=beta)
  // Other-space block tagged work + priority 1 — must never leak into SPACE.
  childBlock(BX, PAGE_OTHER, { priority: '1' })

  blockTags.set(B1, new Set([TAG_WORK]))
  blockTags.set(B3, new Set([TAG_WORK]))
  blockTags.set(BX, new Set([TAG_WORK]))
  // B7 carries the tag ONLY via an inline reference (block_tag_refs), exercising
  // the ref-inclusive `block_tags ∪ block_tag_refs` semantics on BOTH paths.
  blockTagRefs.set(B7, new Set([TAG_WORK]))
})

const deps: InlineQueryResolveDeps = {
  resolveTagPrefix: async (prefix) => (await listTagsByPrefix({ prefix })).map((t) => t.tag_id),
}

async function legacyIds(expr: string): Promise<string[]> {
  const res = await dispatchQuery(parseQueryExpression(expr), undefined, SPACE)
  return res.items.map((b) => b.id).toSorted()
}

async function richIds(expr: string): Promise<string[] | null> {
  const resolved = await resolveLegacyQueryToFilterExpr(parseQueryExpression(expr), deps)
  if (resolved.filterExpr == null) return null
  const res = await fetchRichInlineQuery(resolved.filterExpr, undefined, SPACE)
  return res.items.map((b) => b.id).toSorted()
}

describe('legacy ↔ rich inline-query equivalence', () => {
  const TRANSLATABLE = [
    'tag:work',
    'tag:nonexistent',
    'type:tag expr:work',
    'property:priority=1',
    'property:todo_state=TODO',
    'property:context=@office',
    'property:project=beta',
    'property:due_date=2025-06-01',
    'property:deadline=2025-06-01',
    'property:priority=1 property:todo_state=TODO',
    'property:context=@office tag:work',
    'type:property key:context value:@office',
    // Custom `!=`: present-and-not-equal (B2 has context=@office), excluding
    // both the matching-value block (B8: context=beta) and absent-key blocks.
    'property:context!=beta',
    // Backlinks: the direct children of PAGE (all of B1..B8).
    `type:backlinks target:${PAGE}`,
  ]

  for (const expr of TRANSLATABLE) {
    it(`returns identical results for: ${expr}`, async () => {
      const rich = await richIds(expr)
      // Sanity: these shapes MUST translate (else the reroute silently regressed).
      expect(rich, `expected "${expr}" to be translatable`).not.toBeNull()
      expect(rich).toEqual(await legacyIds(expr))
    })
  }

  it('translatable queries actually match the expected seed blocks (not all-empty)', async () => {
    // Ref-inclusive: B1/B3 (attached) + B7 (inline reference) all match `tag:work`.
    expect(await richIds('tag:work')).toEqual([B1, B3, B7].toSorted())
    expect(await richIds('property:priority=1')).toEqual([B1])
    expect(await richIds('property:context=@office tag:work')).toEqual([]) // B2 has no tag
    expect(await richIds('property:deadline=2025-06-01')).toEqual([B6])
  })

  it('a ref-only-tagged block matches on BOTH paths (ref-inclusion is faithful)', async () => {
    expect(await richIds('tag:work')).toContain(B7)
    expect(await legacyIds('tag:work')).toContain(B7)
  })

  it('never leaks blocks from another space', async () => {
    for (const expr of ['tag:work', 'property:priority=1']) {
      expect(await richIds(expr)).not.toContain(BX)
      expect(await legacyIds(expr)).not.toContain(BX)
    }
  })

  it('keeps genuinely non-translatable shapes on the legacy path (fallback)', async () => {
    // Comparison on a reserved membership column has no engine primitive.
    const nonEq = await resolveLegacyQueryToFilterExpr(
      parseQueryExpression('property:priority>1'),
      deps,
    )
    expect(nonEq.filterExpr).toBeNull()
    expect(nonEq.reasons).toContain('property-not-expressible:priority:gt')

    // Unknown shapes never compile to match-all.
    const unknown = await resolveLegacyQueryToFilterExpr(parseQueryExpression('type:invalid'), deps)
    expect(unknown.filterExpr).toBeNull()
  })
})
