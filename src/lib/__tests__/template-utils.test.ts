/**
 * Equivalent mutants, accepted:
 * - `pages[0]?.` → `pages[0].` in `loadJournalTemplate`'s warning: it is built
 *   only when there are at least two pages.
 * - `formatWithFallback`'s `userFormat == null || userFormat.length === 0` →
 *   `false`: a null format throws inside the `try` and an empty one formats to
 *   `''`, and both fall back.
 * - `body.trim()` → `body` in `resolveLegacyToken`: `head` and `arg` are
 *   trimmed again.
 * - `insertTemplateBlocks`:
 *   - `pid == null` → `false`: every descendant has a parent, and a `null`
 *     key would never be read.
 *   - the `destParentIndex == null ? parentId : null` spec field: the level
 *     loop overwrites every spec's `parentId`.
 *   - `depthByIndex` and `ids` built empty or filled with `undefined`: every
 *     read goes through `?? 0` or the hole filter.
 *   - the past-the-end guards (`<=` in the three index loops,
 *     `deferred[i]?.`, `entry == null`, `idx == null` → `false`): the extra
 *     iteration reads `undefined` and does nothing, and no in-range entry is
 *     null.
 *   - `d > maxDepth` → `>=`: an equal depth assigns the same value.
 *   - `entry.resolveParentFromIndex == null` → `false`: `ids[null]` is
 *     `undefined`, so `?? parentId` picks the same parent.
 *   - `row != null` → `true`: `create_blocks_batch` returns one row per spec.
 *   - `cursorDeferredIndex !== null` → `true`: `ids[null]` is `undefined`, so
 *     the callback still does not fire.
 * - `deleteSpaceTextJournalTemplates`: `?? []` → `['Stryker was here']` (a
 *   string has no `key`), and `writePreference(…, true)` → `false` (the
 *   preference's `serialize` ignores its value).
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { es } from 'date-fns/locale/es'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import {
  type CommandReturns,
  mockInvokeCommands,
  type TypedInvokeHandlers,
} from '@/__tests__/helpers/invoke'
import { unwrap } from '@/lib/app-error'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { registerDateLocale, __unregisterDateLocaleForTests } from '@/lib/i18n/locales'
import { logger } from '@/lib/logger'
import { PREFERENCES, readPreference } from '@/lib/preferences'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import {
  deleteSpaceTextJournalTemplates,
  expandTemplateVariables,
  insertTemplateBlocks,
  loadJournalTemplate,
  loadTemplatePages,
  loadTemplatePagesWithPreview,
} from '@/lib/template-utils'

// #4555 — falsification helper: see the matching comment in
// `src/lib/__tests__/date-utils.test.ts` for why a plain 'xx' tag (rather
// than a real locale) proves TRACKING of `i18n.language`, not a literal.
const TEST_LOCALE_TAG = 'xx'

async function withTestLocale<T>(run: () => T | Promise<T>): Promise<T> {
  registerDateLocale(TEST_LOCALE_TAG, es)
  await i18n.changeLanguage(TEST_LOCALE_TAG)
  try {
    return await run()
  } finally {
    await i18n.changeLanguage('en')
    __unregisterDateLocaleForTests(TEST_LOCALE_TAG)
  }
}

const mockedInvoke = vi.mocked(invoke)

/** Install a command-keyed `invoke`; anything unlisted fails by name. */
function stubTemplates(handlers: TypedInvokeHandlers): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/** The `query_by_property` envelope — a `PageResponse` always carries `total_count`. */
function propertyPage(items: BlockRow[]): CommandReturns['query_by_property'] {
  return { items, next_cursor: null, has_more: false, total_count: null }
}

/**
 * Install a template subtree (`[id, parentId, content, position?]` rows, a
 * missing position being the row's index) and a `create_blocks_batch` that
 * names each created block `NEW_<content>`. Returns every batch's
 * `(content, parentId)` pairs.
 */
function stubTemplateTree(
  rows: Array<[string, string, string | null, (number | null)?]>,
  failBatch?: number,
): Array<Array<[string, string]>> {
  const batches: Array<Array<[string, string]>> = []
  stubTemplates({
    load_page_subtree: () => ({
      blocks: rows.map(([id, parentId, content, position], index) =>
        makeBlockRow({
          id,
          parent_id: parentId,
          content,
          position: position === undefined ? index : position,
        }),
      ),
      truncated: false,
      total: rows.length,
    }),
    create_blocks_batch: (args) => {
      const specs = args['specs'] as Array<{ content: string; parentId: string }>
      batches.push(specs.map((s) => [s.content, s.parentId]))
      if (batches.length === failBatch) throw new Error('batch insert failed')
      return withOps({
        blocks: specs.map((s) => makeBlockRow({ id: `NEW_${s.content}`, content: s.content })),
      })
    },
  })
  return batches
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadTemplatePages', () => {
  it('returns pages with template property', async () => {
    // Backend now drops non-page rows via the
    // `block_type = 'page'` push-down filter (Tier 3.4), so the mock
    // only returns rows that already match.
    stubTemplates({
      query_by_property: () =>
        propertyPage([
          makeBlockRow({ id: 'T1', block_type: 'page', content: 'Meeting Notes' }),
          makeBlockRow({ id: 'T2', block_type: 'page', content: 'Bug Report' }),
        ]),
    })

    const result = await loadTemplatePages('SPACE_1')

    // `blockType: 'page'` is pushed into SQL via
    // Tier 3.4's `query_by_property` push-down, so the IPC carries it
    // as a field of the single `request` DTO (#2277 item 7).
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      request: {
        key: 'template',
        valueText: 'true',
        valueDate: null,
        operator: null,
        cursor: null,
        limit: 100,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: { kind: 'active', space_id: 'SPACE_1' },
    })
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('T1')
    expect(result[1]?.id).toBe('T2')
  })

  it('returns empty array when no templates exist', async () => {
    stubTemplates({ query_by_property: () => propertyPage([]) })

    const result = await loadTemplatePages('SPACE_1')
    expect(result).toHaveLength(0)
  })
})

describe('insertTemplateBlocks', () => {
  it('creates blocks from template children via a single batch IPC', async () => {
    // + limit-clamp-followup — `insertTemplateBlocks`
    // fetches the whole template subtree in ONE `load_page_subtree`
    // IPC, groups descendants by `parent_id`, accumulates one
    // `CreateBlockSpec` per descendant in DFS order, and fires ONE
    // `create_blocks_batch` per depth level. For a flat template with
    // two siblings we expect ONE load_page_subtree and ONE
    // create_blocks_batch (depth 0).
    // #1258 — `load_page_subtree` returns `{ blocks, truncated, total }`.
    stubTemplates({
      load_page_subtree: () => ({
        blocks: [
          makeBlockRow({ id: 'TC1', content: '## Attendees', parent_id: 'TMPL', position: 0 }),
          makeBlockRow({ id: 'TC2', content: '## Agenda', parent_id: 'TMPL', position: 1 }),
        ],
        truncated: false,
        total: 2,
      }),
      // create_blocks_batch → both blocks created in one IPC, returned
      // in input order.
      create_blocks_batch: () =>
        withOps({
          blocks: [
            makeBlockRow({ id: 'NEW1', content: '## Attendees' }),
            makeBlockRow({ id: 'NEW2', content: '## Agenda' }),
          ],
        }),
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(ids).toEqual(['NEW1', 'NEW2'])
    expect(mockedInvoke).toHaveBeenCalledWith(
      'load_page_subtree',
      expect.objectContaining({ rootBlockId: 'TMPL' }),
    )
    // Anti-backslide guard: NO per-parent `list_blocks` IPC fires.
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listCalls).toHaveLength(0)
    // ONE create_blocks_batch call carrying both specs in input order.
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]?.[1]).toMatchObject({
      specs: [
        expect.objectContaining({
          blockType: 'content',
          content: '## Attendees',
          parentId: 'PARENT',
        }),
        expect.objectContaining({
          blockType: 'content',
          content: '## Agenda',
          parentId: 'PARENT',
        }),
      ],
    })

    // Anti-backslide guard: NO per-block `create_block` IPC fires under
    // the batch path (mirrors the Tier 2.1+2.2 anti-regression pattern).
    const perBlockCreateCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(perBlockCreateCalls).toHaveLength(0)
  })

  it('insertTemplateBlocks copies nested children recursively', async () => {
    // + limit-clamp-followup — for a template with
    // depth 2 (TMPL → A → B) the batch fires once per depth level:
    // depth 0 creates A, depth 1 creates B with `parentId = NEW_A`
    // resolved from the previous batch's response. Both descendants
    // arrive in a single `load_page_subtree` response.
    // One batch per depth level, and the ORDER is the subject: depth 0
    // answers NEW_A, depth 1 answers NEW_B.
    let batchLevel = 0
    stubTemplates({
      load_page_subtree: () => ({
        blocks: [
          makeBlockRow({ id: 'A', content: 'Heading A', parent_id: 'TMPL', position: 0 }),
          makeBlockRow({ id: 'B', content: 'Sub-bullet B', parent_id: 'A', position: 0 }),
        ],
        truncated: false,
        total: 2,
      }),
      create_blocks_batch: () => {
        batchLevel += 1
        return withOps({
          blocks:
            batchLevel === 1
              ? [makeBlockRow({ id: 'NEW_A', content: 'Heading A' })]
              : [makeBlockRow({ id: 'NEW_B', content: 'Sub-bullet B' })],
        })
      },
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    // Both blocks were created
    expect(ids).toEqual(['NEW_A', 'NEW_B'])

    // ONE batch call PER DEPTH LEVEL (two depths → two batches).
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(2)

    // Anti-backslide guard: zero per-block `create_block` calls.
    const perBlockCreateCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(perBlockCreateCalls).toHaveLength(0)

    // Depth 1 batch must reference NEW_A as the parent (forward
    // reference from depth-0 batch response).
    const depthOneSpecs = (batchCalls[1]?.[1] as { specs: Array<{ parentId: string }> } | undefined)
      ?.specs
    expect(depthOneSpecs?.[0]?.parentId).toBe('NEW_A')

    // Anti-backslide guard: NO per-parent `list_blocks` IPC fires —
    // the subtree arrives in a single `load_page_subtree` call.
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listCalls).toHaveLength(0)
    const subtreeCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'load_page_subtree')
    expect(subtreeCalls).toHaveLength(1)
  })

  it('returns ids accumulated up to the failing batch level', async () => {
    // Atomicity changed: a per-batch failure logs a
    // warning and returns the already-landed prefix from earlier
    // levels. (Each level is its own all-or-nothing tx; failures
    // aren't backed out across levels because the previous-level
    // commit already happened.)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    // The batch ORDER is the subject: depth 0 succeeds, depth 1 fails.
    const failure = new Error('batch insert failed')
    let batchLevel = 0
    stubTemplates({
      // load_page_subtree(TMPL) → A (root child) + B (A's child)
      load_page_subtree: () => ({
        blocks: [
          makeBlockRow({ id: 'A', content: 'A', parent_id: 'TMPL', position: 0 }),
          makeBlockRow({ id: 'B', content: 'B', parent_id: 'A', position: 0 }),
        ],
        truncated: false,
        total: 2,
      }),
      create_blocks_batch: () => {
        batchLevel += 1
        if (batchLevel === 1)
          return withOps({ blocks: [makeBlockRow({ id: 'NEW_A', content: 'A' })] })
        throw failure
      },
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    // A landed from depth 0; depth-1 failure is logged but doesn't
    // throw — the partial result is returned.
    expect(ids).toEqual(['NEW_A'])
    expect(warnSpy).toHaveBeenCalledWith(
      'template-utils',
      'template batch insert failed at depth level',
      { level: 1, count: 1 },
      expect.objectContaining({ message: failure.message }),
    )
    warnSpy.mockRestore()
  })

  it('copies a three-level template whose last block is top-level, each block under its copy', async () => {
    const batches = stubTemplateTree([
      ['A', 'TMPL', 'a'],
      ['B', 'A', 'b'],
      ['C', 'B', 'c'],
      ['D', 'TMPL', 'd'],
    ])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(ids).toEqual(['NEW_a', 'NEW_b', 'NEW_c', 'NEW_d'])
    expect(batches).toEqual([
      [
        ['a', 'PARENT'],
        ['d', 'PARENT'],
      ],
      [['b', 'NEW_a']],
      [['c', 'NEW_b']],
    ])
  })

  it('copies a template block with no content as an empty block', async () => {
    const batches = stubTemplateTree([['A', 'TMPL', null]])

    await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(batches).toEqual([[['', 'PARENT']]])
  })

  // `load_page_subtree` documents its row order as not load-bearing, so the
  // copy orders siblings itself.
  it('copies siblings in position order, unpositioned last, whatever order the rows arrive in', async () => {
    const batches = stubTemplateTree([
      ['U', 'TMPL', 'unpositioned', null],
      ['C', 'TMPL', 'third', 7],
      ['A', 'TMPL', 'first', 1],
      ['B', 'TMPL', 'second', 3],
    ])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(ids).toEqual(['NEW_first', 'NEW_second', 'NEW_third', 'NEW_unpositioned'])
    expect(batches.map((batch) => batch.map(([content]) => content))).toEqual([
      ['first', 'second', 'third', 'unpositioned'],
    ])
  })

  it('returns empty array when template has no children', async () => {
    // load_page_subtree returns no descendants → no batch IPC fires.
    stubTemplates({ load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }) })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(ids).toEqual([])
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(0)
  })
})

describe('insertTemplateBlocks — {{ }} variable substitution (#1442)', () => {
  it('expands {{date}} and {{title}} in copied template blocks', async () => {
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const today = `${yyyy}-${mm}-${dd}`

    stubTemplates({
      // load_page_subtree → two template blocks carrying {{date}} / {{title}}.
      load_page_subtree: () => ({
        blocks: [
          makeBlockRow({ id: 'TC1', content: 'Due: {{date}}', parent_id: 'TMPL', position: 0 }),
          makeBlockRow({ id: 'TC2', content: 'For {{title}}', parent_id: 'TMPL', position: 1 }),
        ],
        truncated: false,
        total: 2,
      }),
      // create_blocks_batch → echoes content back in input order.
      create_blocks_batch: () =>
        withOps({
          blocks: [
            makeBlockRow({ id: 'NEW1', content: `Due: ${today}` }),
            makeBlockRow({ id: 'NEW2', content: 'For Weekly Review' }),
          ],
        }),
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST', {
      pageTitle: 'Weekly Review',
    })

    expect(ids).toEqual(['NEW1', 'NEW2'])
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    const specs = (batchCalls[0]?.[1] as { specs: Array<{ content: string }> } | undefined)?.specs
    expect(specs?.[0]?.content).toBe(`Due: ${today}`)
    expect(specs?.[1]?.content).toBe('For Weekly Review')
  })

  it('strips {{cursor}} and reports the created block via onCursorBlock', async () => {
    stubTemplates({
      load_page_subtree: () => ({
        blocks: [
          makeBlockRow({ id: 'A', content: 'first', parent_id: 'TMPL', position: 0 }),
          makeBlockRow({ id: 'B', content: 'here{{cursor}}', parent_id: 'TMPL', position: 1 }),
        ],
        truncated: false,
        total: 2,
      }),
      create_blocks_batch: () =>
        withOps({
          blocks: [
            makeBlockRow({ id: 'NEW_A', content: 'first' }),
            makeBlockRow({ id: 'NEW_B', content: 'here' }),
          ],
        }),
    })

    let cursorBlockId: string | null = null
    await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST', {
      onCursorBlock: (blockId) => {
        cursorBlockId = blockId
      },
    })

    // The marker block's created id is reported, and the marker is stripped
    // from the inserted content.
    expect(cursorBlockId).toBe('NEW_B')
    const batchCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'create_blocks_batch')
    const specs = (batchCall?.[1] as { specs: Array<{ content: string }> } | undefined)?.specs
    expect(specs?.[1]?.content).toBe('here')
  })

  it('reports the first of several {{cursor}} blocks', async () => {
    stubTemplateTree([
      ['A', 'TMPL', 'a'],
      ['B', 'TMPL', 'b{{cursor}}'],
      ['C', 'TMPL', 'c{{cursor}}'],
    ])
    const onCursorBlock = vi.fn()

    await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST', { onCursorBlock })

    expect(onCursorBlock.mock.calls).toEqual([['NEW_b']])
  })

  it('inserts a {{cursor}} template for a caller that passes no context', async () => {
    const batches = stubTemplateTree([['A', 'TMPL', 'a{{cursor}}']])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST')

    expect(ids).toEqual(['NEW_a'])
    expect(batches).toEqual([[['a', 'PARENT']]])
  })

  it('reports no cursor block when the level holding it fails to land', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    stubTemplateTree(
      [
        ['A', 'TMPL', 'a'],
        ['B', 'A', 'b{{cursor}}'],
      ],
      2,
    )
    const onCursorBlock = vi.fn()

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', 'SPACE_TEST', { onCursorBlock })

    expect(ids).toEqual(['NEW_a'])
    expect(onCursorBlock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('short-circuits to [] with no active space, dispatching no load_page_subtree (b1)', async () => {
    // b1 — the descendant fetch (`load_page_subtree`) is required-active.
    // With `spaceId == null` there is no template to expand, so
    // `insertTemplateBlocks` returns an empty id list WITHOUT dispatching
    // (a Global scope would be rejected by the backend).
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    expect(ids).toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
    expect(warnSpy).toHaveBeenCalledWith(
      'template-utils',
      'insertTemplateBlocks: no active space; skipping',
      {},
    )
    warnSpy.mockRestore()
  })
})

describe('loadJournalTemplate', () => {
  it('returns the journal template page when it exists', async () => {
    stubTemplates({
      query_by_property: () =>
        propertyPage([
          makeBlockRow({ id: 'JT1', block_type: 'page', content: 'Journal Template' }),
        ]),
    })

    const { template, duplicateWarning } = await loadJournalTemplate('SPACE_1')

    expect(template).not.toBeNull()
    expect(template?.id).toBe('JT1')
    expect(duplicateWarning).toBeNull()
    // `blockType: 'page'` keeps a content block carrying the property from
    // being taken for the journal template.
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      request: {
        key: 'journal-template',
        valueText: 'true',
        valueDate: null,
        operator: null,
        cursor: null,
        limit: 10,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: { kind: 'active', space_id: 'SPACE_1' },
    })
  })

  it('returns null when no journal template exists', async () => {
    stubTemplates({ query_by_property: () => propertyPage([]) })

    const { template, duplicateWarning } = await loadJournalTemplate('SPACE_1')
    expect(template).toBeNull()
    expect(duplicateWarning).toBeNull()
  })

  it('returns duplicateWarning when multiple journal templates exist', async () => {
    stubTemplates({
      query_by_property: () =>
        propertyPage([
          makeBlockRow({ id: 'JT1', block_type: 'page', content: 'Daily Journal' }),
          makeBlockRow({ id: 'JT2', block_type: 'page', content: 'Weekly Journal' }),
        ]),
    })

    const { template, duplicateWarning } = await loadJournalTemplate('SPACE_1')

    expect(template).not.toBeNull()
    expect(template?.id).toBe('JT1')
    expect(duplicateWarning).toBe(
      'Multiple journal templates found (2). Using "Daily Journal". ' +
        'Remove the journal-template property from extra pages to avoid ambiguity.',
    )
  })

  it('returns null duplicateWarning when exactly one template exists', async () => {
    stubTemplates({
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'JT1', block_type: 'page', content: 'Only Journal' })]),
    })

    const { duplicateWarning } = await loadJournalTemplate('SPACE_1')
    expect(duplicateWarning).toBeNull()
  })
})

describe('loadTemplatePagesWithPreview', () => {
  it('returns pages with first child content as preview', async () => {
    stubTemplates({
      // query_by_property → 1 template page
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'T1', block_type: 'page', content: 'Meeting Notes' })]),
      // first_child_for_blocks([T1]) returns { T1: child } in a single batch call.
      first_child_for_blocks: () => ({
        T1: makeBlockRow({ id: 'C1', content: '## Attendees', parent_id: 'T1', position: 0 }),
      }),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')
    expect(result).toHaveLength(1)
    expect(result[0]?.preview).toBe('## Attendees')
    // \u2014 single batch IPC for previews. The per-template
    // `list_blocks({ parentId, limit: 1 })` loop is gone.
    expect(mockedInvoke).toHaveBeenCalledWith('first_child_for_blocks', {
      blockIds: ['T1'],
    })
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(0)
  })

  it('returns null preview when template has no children', async () => {
    stubTemplates({
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'T1', block_type: 'page', content: 'Empty Template' })]),
      // Empty record \u2014 T1 omitted because it has no children.
      first_child_for_blocks: () => ({}),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')
    expect(result[0]?.preview).toBeNull()
  })

  it('truncates long preview text at 60 chars', async () => {
    const longContent = 'A'.repeat(80)
    stubTemplates({
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'T1', block_type: 'page', content: 'Long Template' })]),
      first_child_for_blocks: () => ({
        T1: makeBlockRow({ id: 'C1', content: longContent, parent_id: 'T1', position: 0 }),
      }),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')
    expect(result[0]?.preview).toBe(`${'A'.repeat(60)}\u2026`)
  })

  it('keeps a preview of exactly 60 chars whole', async () => {
    const content = 'B'.repeat(60)
    stubTemplates({
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'T1', block_type: 'page', content: 'Template' })]),
      first_child_for_blocks: () => ({
        T1: makeBlockRow({ id: 'C1', content, parent_id: 'T1', position: 0 }),
      }),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')
    expect(result[0]?.preview).toBe(content)
  })

  it('carries each page title, and reads a missing title or child text as empty', async () => {
    stubTemplates({
      query_by_property: () =>
        propertyPage([
          makeBlockRow({ id: 'T1', block_type: 'page', content: 'Standup' }),
          makeBlockRow({ id: 'T2', block_type: 'page', content: null }),
        ]),
      first_child_for_blocks: () => ({
        T2: makeBlockRow({ id: 'C2', content: null, parent_id: 'T2', position: 0 }),
      }),
    })

    expect(await loadTemplatePagesWithPreview('SPACE_1')).toEqual([
      { id: 'T1', content: 'Standup', preview: null },
      { id: 'T2', content: '', preview: '' },
    ])
  })

  it('fetches no previews when there are no templates', async () => {
    stubTemplates({ query_by_property: () => propertyPage([]) })

    expect(await loadTemplatePagesWithPreview('SPACE_1')).toEqual([])
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(['query_by_property'])
  })

  it('handles preview fetch failure gracefully', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    stubTemplates({
      query_by_property: () =>
        propertyPage([makeBlockRow({ id: 'T1', block_type: 'page', content: 'Template' })]),
      // Batch fetch rejection \u2014 every page surfaces a null preview.
      first_child_for_blocks: () => Promise.reject(new Error('first_child_for_blocks failed')),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')
    expect(result[0]?.preview).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      'template-utils',
      'template preview batch fetch failed',
      { templateCount: 1 },
      expect.objectContaining({ message: 'first_child_for_blocks failed' }),
    )
    warnSpy.mockRestore()
  })

  it('fires a single batch preview IPC for many templates', async () => {
    // Three templates \u2192 one query_by_property + one first_child_for_blocks.
    stubTemplates({
      query_by_property: () =>
        propertyPage([
          makeBlockRow({ id: 'T1', block_type: 'page', content: 'A' }),
          makeBlockRow({ id: 'T2', block_type: 'page', content: 'B' }),
          makeBlockRow({ id: 'T3', block_type: 'page', content: 'C' }),
        ]),
      first_child_for_blocks: () => ({
        T1: makeBlockRow({ id: 'C1', content: 'first-A', parent_id: 'T1', position: 0 }),
        T3: makeBlockRow({ id: 'C3', content: 'first-C', parent_id: 'T3', position: 0 }),
      }),
    })

    const result = await loadTemplatePagesWithPreview('SPACE_1')

    expect(result).toHaveLength(3)
    expect(result[0]?.preview).toBe('first-A')
    expect(result[1]?.preview).toBeNull()
    expect(result[2]?.preview).toBe('first-C')

    // Exactly two IPCs total: the property query + the preview batch.
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
    expect(mockedInvoke).toHaveBeenLastCalledWith('first_child_for_blocks', {
      blockIds: ['T1', 'T2', 'T3'],
    })
  })
})

describe('expandTemplateVariables', () => {
  it('expands <% today %> to current date', () => {
    const result = expandTemplateVariables('Due: <% today %>', {})
    expect(result).toMatch(/Due: \d{4}-\d{2}-\d{2}/)
  })

  it('expands <% time %> to current time', () => {
    const result = expandTemplateVariables('At: <% time %>', {})
    expect(result).toMatch(/At: \d{2}:\d{2}/)
  })

  it('expands <% datetime %> to date and time', () => {
    const result = expandTemplateVariables('Created: <% datetime %>', {})
    expect(result).toMatch(/Created: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('expands <% page title %> from context', () => {
    const result = expandTemplateVariables('Page: <% page title %>', { pageTitle: 'My Notes' })
    expect(result).toBe('Page: My Notes')
  })

  it('expands <% page title %> to empty when no context', () => {
    const result = expandTemplateVariables('Page: <% page title %>', {})
    expect(result).toBe('Page: ')
  })

  it('expands multiple variables in one string', () => {
    const result = expandTemplateVariables('Date: <% today %>, Page: <% page title %>', {
      pageTitle: 'Test',
    })
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}, Page: Test/)
  })

  it('is case-insensitive', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const result = expandTemplateVariables('<% TODAY %> <% Today %>', {})
    expect(result).toBe(`${today} ${today}`)
  })

  it('handles whitespace variations in delimiters', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const result = expandTemplateVariables('<%today%> <% today  %>', {})
    expect(result).toBe(`${today} ${today}`)
  })

  it('leaves unknown variables unchanged', () => {
    const result = expandTemplateVariables('<% unknown %>', {})
    expect(result).toBe('<% unknown %>')
  })

  it('returns content unchanged when no variables present', () => {
    expect(expandTemplateVariables('Hello world', {})).toBe('Hello world')
  })
})

describe('expandTemplateVariables — resolver map (#1450 Phase 1)', () => {
  // A fixed clock so date/time assertions are deterministic.
  // 2026-03-07 09:05 local time — a Saturday, ISO week 10.
  const NOW = new Date(2026, 2, 7, 9, 5, 0)

  describe('existing tokens are byte-unchanged under a fixed clock', () => {
    it('<% today %> → YYYY-MM-DD (local)', () => {
      expect(expandTemplateVariables('<% today %>', { now: NOW })).toBe('2026-03-07')
    })

    it('<% time %> → HH:MM (local)', () => {
      expect(expandTemplateVariables('<% time %>', { now: NOW })).toBe('09:05')
    })

    it('<% datetime %> → YYYY-MM-DD HH:MM (local)', () => {
      expect(expandTemplateVariables('<% datetime %>', { now: NOW })).toBe('2026-03-07 09:05')
    })

    it('<% page title %> → context title', () => {
      expect(expandTemplateVariables('<% page title %>', { now: NOW, pageTitle: 'Notes' })).toBe(
        'Notes',
      )
    })

    it('<% page title %> → empty string when no title', () => {
      expect(expandTemplateVariables('<% page title %>', { now: NOW })).toBe('')
    })

    it('collapses internal whitespace in page title token', () => {
      expect(expandTemplateVariables('<%  page   title  %>', { now: NOW, pageTitle: 'X' })).toBe(
        'X',
      )
    })
  })

  describe('configurable date/time formats', () => {
    it('<% today:DD/MM/YYYY %> maps user tokens onto date-fns', () => {
      expect(expandTemplateVariables('<% today:DD/MM/YYYY %>', { now: NOW })).toBe('07/03/2026')
    })

    it('<% time:HH:mm %> tolerates colons inside the format', () => {
      expect(expandTemplateVariables('<% time:HH:mm %>', { now: NOW })).toBe('09:05')
    })

    it('<% datetime:FORMAT %> formats a raw date-fns pattern', () => {
      expect(expandTemplateVariables('<% datetime:yyyy-MM-dd %>', { now: NOW })).toBe('2026-03-07')
    })

    it('<% today:YYYY %> for the year alone', () => {
      expect(expandTemplateVariables('<% today:YYYY %>', { now: NOW })).toBe('2026')
    })

    it('falls back to the default (no throw) on an invalid format', () => {
      // `ooooo` is an unescaped-latin token that date-fns rejects with a
      // RangeError — the resolver must swallow it and fall back to the default.
      expect(expandTemplateVariables('<% today:ooooo %>', { now: NOW })).toBe('2026-03-07')
    })

    it('falls back to the default when the format formats to nothing', () => {
      // A lone quote opens an empty literal: date-fns returns ''.
      expect(expandTemplateVariables("<% today:' %>", { now: NOW })).toBe('2026-03-07')
    })

    it('ignores spaces around the colon', () => {
      expect(expandTemplateVariables('<% today : DD/MM/YYYY %>', { now: NOW })).toBe('07/03/2026')
    })
  })

  describe('date math', () => {
    it('<% date+7 %> → today plus 7 days (default format)', () => {
      expect(expandTemplateVariables('<% date+7 %>', { now: NOW })).toBe('2026-03-14')
    })

    it('<% date-1 %> → today minus 1 day (default format)', () => {
      expect(expandTemplateVariables('<% date-1 %>', { now: NOW })).toBe('2026-03-06')
    })

    it('<% date+7:YYYY-MM-DD %> combines date math with a format', () => {
      expect(expandTemplateVariables('<% date+7:YYYY-MM-DD %>', { now: NOW })).toBe('2026-03-14')
    })

    it('crosses a month boundary correctly', () => {
      expect(expandTemplateVariables('<% date+30 %>', { now: NOW })).toBe('2026-04-06')
    })

    it('leaves a token that only contains date math verbatim', () => {
      expect(expandTemplateVariables('<% xdate+1 %> <% date+1x %>', { now: NOW })).toBe(
        '<% xdate+1 %> <% date+1x %>',
      )
    })
  })

  describe('new built-ins', () => {
    it('<% weekday %> → full day name', () => {
      expect(expandTemplateVariables('<% weekday %>', { now: NOW })).toBe('Saturday')
    })

    it('<% month %> → full month name', () => {
      expect(expandTemplateVariables('<% month %>', { now: NOW })).toBe('March')
    })

    it('<% isoweek %> → ISO week number', () => {
      expect(expandTemplateVariables('<% isoweek %>', { now: NOW })).toBe('10')
    })

    it('built-ins accept a format argument (weekday:EEE)', () => {
      expect(expandTemplateVariables('<% weekday:EEE %>', { now: NOW })).toBe('Sat')
    })

    // #4555 — `weekday`/`month` (and any user-supplied FORMAT argument)
    // used to always render English regardless of `i18n.language`. Pins
    // the tracking behaviour, not a literal — the app locale is the same
    // source the UI catalog resolves from, so this can never disagree
    // with it.
    describe('resolve through the app date locale', () => {
      it('<% weekday %> follows the app locale', async () => {
        await withTestLocale(() => {
          expect(expandTemplateVariables('<% weekday %>', { now: NOW })).toBe('sábado')
        })
        expect(expandTemplateVariables('<% weekday %>', { now: NOW })).toBe('Saturday')
      })

      it('<% month %> follows the app locale', async () => {
        await withTestLocale(() => {
          expect(expandTemplateVariables('<% month %>', { now: NOW })).toBe('marzo')
        })
        expect(expandTemplateVariables('<% month %>', { now: NOW })).toBe('March')
      })

      it('a user FORMAT argument follows the app locale', async () => {
        await withTestLocale(() => {
          expect(expandTemplateVariables('<% today:MMMM d, YYYY %>', { now: NOW })).toBe(
            'marzo 7, 2026',
          )
        })
        expect(expandTemplateVariables('<% today:MMMM d, YYYY %>', { now: NOW })).toBe(
          'March 7, 2026',
        )
      })
    })
  })

  it('is case-insensitive for new tokens too', () => {
    expect(expandTemplateVariables('<% WEEKDAY %> <% Month %>', { now: NOW })).toBe(
      'Saturday March',
    )
  })

  it('leaves unknown tokens verbatim (does not drop them)', () => {
    expect(expandTemplateVariables('<% unknown %> <% foo:bar %>', { now: NOW })).toBe(
      '<% unknown %> <% foo:bar %>',
    )
  })

  it('expands multiple tokens in one string', () => {
    expect(
      expandTemplateVariables('<% today %> — <% weekday %> (<% page title %>)', {
        now: NOW,
        pageTitle: 'Standup',
      }),
    ).toBe('2026-03-07 — Saturday (Standup)')
  })

  it('uses the live clock by default when no now is supplied', () => {
    expect(expandTemplateVariables('<% today %>', {})).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('deleteSpaceTextJournalTemplates', () => {
  const SPACE = 'SPACE_PERSONAL'

  async function setTextTemplate(): Promise<void> {
    unwrap(
      await commands.setProperty(SPACE, 'journal_template', {
        value_text: '- Notes\n  - nested',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }),
    )
  }

  async function textTemplate(): Promise<PropertyRow | null> {
    return unwrap(await commands.getProperty(SPACE, 'journal_template'))
  }

  beforeEach(() => {
    localStorage.clear()
    seedBlocks()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  it('deletes the text template from the space and records the device as done', async () => {
    await setTextTemplate()

    await deleteSpaceTextJournalTemplates([SPACE])

    expect(await textTemplate()).toBeNull()
    expect(readPreference(PREFERENCES.spaceTextJournalTemplatesDeleted)).toBe(true)
  })

  it('does nothing on a later run once the device is done', async () => {
    await deleteSpaceTextJournalTemplates([SPACE])
    // A text template that syncs in afterwards is left alone: this device is done.
    await setTextTemplate()

    await deleteSpaceTextJournalTemplates([SPACE])

    expect(await textTemplate()).not.toBeNull()
  })

  it('appends no delete op for a space without a text template', async () => {
    await deleteSpaceTextJournalTemplates([SPACE])

    const deletes = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_property')
    expect(deletes).toHaveLength(0)
    expect(readPreference(PREFERENCES.spaceTextJournalTemplatesDeleted)).toBe(true)
  })

  it('leaves the device not done when a delete fails, so the next boot retries', async () => {
    stubTemplates({
      get_batch_properties: () => ({
        [SPACE]: [
          {
            key: 'journal_template',
            value_text: 'Notes',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      }),
      delete_property: () => Promise.reject(new Error('backend down')),
    })
    const warn = vi.spyOn(logger, 'warn')

    await deleteSpaceTextJournalTemplates([SPACE])

    expect(readPreference(PREFERENCES.spaceTextJournalTemplatesDeleted)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      'template-utils',
      'deleting the per-space text journal templates failed; retrying next boot',
      { spaceIds: [SPACE] },
      expect.any(Error),
    )
    warn.mockRestore()
  })
})

// #5415 — template lookups carry the active space; with none known they
// resolve empty without dispatching.
describe('template lookups — no active space', () => {
  it('loadTemplatePages / loadJournalTemplate resolve empty without an IPC', async () => {
    stubTemplates({})

    expect(await loadTemplatePages(null)).toEqual([])
    expect(await loadJournalTemplate(null)).toEqual({ template: null, duplicateWarning: null })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
