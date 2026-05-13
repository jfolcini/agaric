import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expandTemplateVariables,
  insertTemplateBlocks,
  insertTemplateBlocksFromString,
  loadJournalTemplate,
  loadJournalTemplateForSpace,
  loadTemplatePages,
  loadTemplatePagesWithPreview,
} from '../template-utils'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadTemplatePages', () => {
  it('returns pages with template property', async () => {
    // PEND-35 Tier 2.8 — backend now drops non-page rows via the
    // `block_type = 'page'` push-down filter (Tier 3.4), so the mock
    // only returns rows that already match.
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'T1', block_type: 'page', content: 'Meeting Notes' },
        { id: 'T2', block_type: 'page', content: 'Bug Report' },
      ],
      next_cursor: null,
      has_more: false,
    })

    const result = await loadTemplatePages(null)

    // PEND-35 Tier 2.8 — `blockType: 'page'` is pushed into SQL via
    // Tier 3.4's `query_by_property` push-down, so the IPC carries it
    // in the `extraFilters` struct.
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'template',
      valueText: 'true',
      valueDate: null,
      operator: null,
      cursor: null,
      limit: 100,
      scope: { kind: 'global' },
      extraFilters: {
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
      },
    })
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('T1')
    expect(result[1]?.id).toBe('T2')
  })

  it('returns empty array when no templates exist', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const result = await loadTemplatePages(null)
    expect(result).toHaveLength(0)
  })
})

describe('insertTemplateBlocks', () => {
  it('creates blocks from template children via a single batch IPC', async () => {
    // PEND-35 Tier 4.3 + limit-clamp-followup — `insertTemplateBlocks`
    // fetches the whole template subtree in ONE `load_page_subtree`
    // IPC, groups descendants by `parent_id`, accumulates one
    // `CreateBlockSpec` per descendant in DFS order, and fires ONE
    // `create_blocks_batch` per depth level. For a flat template with
    // two siblings we expect ONE load_page_subtree and ONE
    // create_blocks_batch (depth 0).
    mockedInvoke.mockResolvedValueOnce([
      {
        id: 'TC1',
        block_type: 'content',
        content: '## Attendees',
        parent_id: 'TMPL',
        position: 0,
      },
      { id: 'TC2', block_type: 'content', content: '## Agenda', parent_id: 'TMPL', position: 1 },
    ])
    // create_blocks_batch → both blocks created in one IPC, returned
    // in input order.
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW1', block_type: 'content', content: '## Attendees' },
      { id: 'NEW2', block_type: 'content', content: '## Agenda' },
    ])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

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
    // PEND-35 Tier 4.3 + limit-clamp-followup — for a template with
    // depth 2 (TMPL → A → B) the batch fires once per depth level:
    // depth 0 creates A, depth 1 creates B with `parentId = NEW_A`
    // resolved from the previous batch's response. Both descendants
    // arrive in a single `load_page_subtree` response.
    mockedInvoke.mockResolvedValueOnce([
      { id: 'A', block_type: 'content', content: 'Heading A', parent_id: 'TMPL', position: 0 },
      { id: 'B', block_type: 'content', content: 'Sub-bullet B', parent_id: 'A', position: 0 },
    ])
    // create_blocks_batch (depth 0) → returns NEW_A
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW_A', block_type: 'content', content: 'Heading A' },
    ])
    // create_blocks_batch (depth 1) → returns NEW_B
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW_B', block_type: 'content', content: 'Sub-bullet B' },
    ])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

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
    const depthOneSpecs = (batchCalls[1]?.[1] as { specs: Array<{ parentId: string }> }).specs
    expect(depthOneSpecs[0]?.parentId).toBe('NEW_A')

    // Anti-backslide guard: NO per-parent `list_blocks` IPC fires —
    // the subtree arrives in a single `load_page_subtree` call.
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listCalls).toHaveLength(0)
    const subtreeCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'load_page_subtree')
    expect(subtreeCalls).toHaveLength(1)
  })

  it('returns ids accumulated up to the failing batch level', async () => {
    // PEND-35 Tier 4.3 — atomicity changed: a per-batch failure logs a
    // warning and returns the already-landed prefix from earlier
    // levels. (Each level is its own all-or-nothing tx; failures
    // aren't backed out across levels because the previous-level
    // commit already happened.)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // load_page_subtree(TMPL) → A (root child) + B (A's child)
    mockedInvoke.mockResolvedValueOnce([
      { id: 'A', block_type: 'content', content: 'A', parent_id: 'TMPL', position: 0 },
      { id: 'B', block_type: 'content', content: 'B', parent_id: 'A', position: 0 },
    ])
    // depth 0 → success
    mockedInvoke.mockResolvedValueOnce([{ id: 'NEW_A', block_type: 'content', content: 'A' }])
    // depth 1 → fail
    mockedInvoke.mockRejectedValueOnce(new Error('batch insert failed'))

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    // A landed from depth 0; depth-1 failure is logged but doesn't
    // throw — the partial result is returned.
    expect(ids).toEqual(['NEW_A'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('template batch insert failed at depth level'),
    )
    warnSpy.mockRestore()
  })

  it('returns empty array when template has no children', async () => {
    // load_page_subtree returns no descendants → no batch IPC fires.
    mockedInvoke.mockResolvedValueOnce([])

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    expect(ids).toEqual([])
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(0)
  })
})

describe('loadJournalTemplate', () => {
  it('returns the journal template page when it exists', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'JT1', block_type: 'page', content: 'Journal Template' }],
      next_cursor: null,
      has_more: false,
    })

    const { template, duplicateWarning } = await loadJournalTemplate(null)

    expect(template).not.toBeNull()
    expect(template?.id).toBe('JT1')
    expect(duplicateWarning).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      expect.objectContaining({
        key: 'journal-template',
        valueText: 'true',
      }),
    )
  })

  it('returns null when no journal template exists', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const { template, duplicateWarning } = await loadJournalTemplate(null)
    expect(template).toBeNull()
    expect(duplicateWarning).toBeNull()
  })

  it('returns duplicateWarning when multiple journal templates exist', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'JT1', block_type: 'page', content: 'Daily Journal' },
        { id: 'JT2', block_type: 'page', content: 'Weekly Journal' },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { template, duplicateWarning } = await loadJournalTemplate(null)

    expect(template).not.toBeNull()
    expect(template?.id).toBe('JT1')
    expect(duplicateWarning).not.toBeNull()
    expect(duplicateWarning).toContain('Multiple journal templates found (2)')
    expect(duplicateWarning).toContain('Daily Journal')
  })

  it('returns null duplicateWarning when exactly one template exists', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'JT1', block_type: 'page', content: 'Only Journal' }],
      next_cursor: null,
      has_more: false,
    })

    const { duplicateWarning } = await loadJournalTemplate(null)
    expect(duplicateWarning).toBeNull()
  })
})

describe('loadTemplatePagesWithPreview', () => {
  it('returns pages with first child content as preview', async () => {
    // Mock query_by_property → 1 template page
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'T1', block_type: 'page', content: 'Meeting Notes' }],
      next_cursor: null,
      has_more: false,
    })
    // PEND-35 Tier 2.8 — first_child_for_blocks([T1]) returns
    // { T1: child } in a single batch call.
    mockedInvoke.mockResolvedValueOnce({
      T1: {
        id: 'C1',
        block_type: 'content',
        content: '## Attendees',
        parent_id: 'T1',
        position: 0,
      },
    })

    const result = await loadTemplatePagesWithPreview(null)
    expect(result).toHaveLength(1)
    expect(result[0]?.preview).toBe('## Attendees')
    // PEND-35 Tier 2.8 \u2014 single batch IPC for previews. The per-template
    // `list_blocks({ parentId, limit: 1 })` loop is gone.
    expect(mockedInvoke).toHaveBeenCalledWith('first_child_for_blocks', {
      blockIds: ['T1'],
    })
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(0)
  })

  it('returns null preview when template has no children', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'T1', block_type: 'page', content: 'Empty Template' }],
      next_cursor: null,
      has_more: false,
    })
    // Empty record \u2014 T1 omitted because it has no children.
    mockedInvoke.mockResolvedValueOnce({})

    const result = await loadTemplatePagesWithPreview(null)
    expect(result[0]?.preview).toBeNull()
  })

  it('truncates long preview text at 60 chars', async () => {
    const longContent = 'A'.repeat(80)
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'T1', block_type: 'page', content: 'Long Template' }],
      next_cursor: null,
      has_more: false,
    })
    mockedInvoke.mockResolvedValueOnce({
      T1: { id: 'C1', block_type: 'content', content: longContent, parent_id: 'T1', position: 0 },
    })

    const result = await loadTemplatePagesWithPreview(null)
    expect(result[0]?.preview).toBe(`${'A'.repeat(60)}\u2026`)
  })

  it('handles preview fetch failure gracefully', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'T1', block_type: 'page', content: 'Template' }],
      next_cursor: null,
      has_more: false,
    })
    // Batch fetch rejection \u2014 every page surfaces a null preview.
    mockedInvoke.mockRejectedValueOnce(new Error('first_child_for_blocks failed'))

    const result = await loadTemplatePagesWithPreview(null)
    expect(result[0]?.preview).toBeNull()
  })

  it('fires a single batch preview IPC for many templates', async () => {
    // Three templates \u2192 one query_by_property + one first_child_for_blocks.
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'T1', block_type: 'page', content: 'A' },
        { id: 'T2', block_type: 'page', content: 'B' },
        { id: 'T3', block_type: 'page', content: 'C' },
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedInvoke.mockResolvedValueOnce({
      T1: { id: 'C1', block_type: 'content', content: 'first-A', parent_id: 'T1', position: 0 },
      T3: { id: 'C3', block_type: 'content', content: 'first-C', parent_id: 'T3', position: 0 },
    })

    const result = await loadTemplatePagesWithPreview(null)

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

describe('loadJournalTemplateForSpace', () => {
  it('returns null when the journal_template property is absent', async () => {
    // PEND-35 Tier 2.4c — backend returns `null` for the missing row
    // (single-key PK lookup), not an empty list of unrelated rows.
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
      blockId: 'SPACE_1',
      key: 'journal_template',
    })
  })

  it('returns value_text when journal_template is set', async () => {
    // PEND-35 Tier 2.4c — single-row return shape from `get_property`.
    mockedInvoke.mockResolvedValueOnce({
      key: 'journal_template',
      value_text: '## Standup\n- TODOs',
      value_num: null,
      value_date: null,
      value_ref: null,
    })

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBe('## Standup\n- TODOs')
    expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
      blockId: 'SPACE_1',
      key: 'journal_template',
    })
  })

  it('reads journal_template directly via PK lookup', async () => {
    // PEND-35 Tier 2.4c — the SQL WHERE-key filter is the backend's
    // job; the FE just trusts the row it gets back. This test pins
    // that the `journal_template` row is read directly via the PK
    // lookup (no client-side `find` over the full vocabulary).
    mockedInvoke.mockResolvedValueOnce({
      key: 'journal_template',
      value_text: 'Daily focus',
      value_num: null,
      value_date: null,
      value_ref: null,
    })

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBe('Daily focus')
    expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
      blockId: 'SPACE_1',
      key: 'journal_template',
    })
  })

  it('returns null when value_text is null', async () => {
    mockedInvoke.mockResolvedValueOnce({
      key: 'journal_template',
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
    })

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBeNull()
  })
})

describe('insertTemplateBlocksFromString', () => {
  it('creates one block per non-empty line via a single batch IPC', async () => {
    // PEND-35 Tier 4.3 — N markdown lines collapse to ONE
    // `create_blocks_batch` IPC. The previous N `create_block` IPCs
    // are gone.
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW1', block_type: 'content', content: 'Morning standup' },
      { id: 'NEW2', block_type: 'content', content: 'TODOs' },
    ])

    const ids = await insertTemplateBlocksFromString('Morning standup\nTODOs', 'PARENT')

    expect(ids).toEqual(['NEW1', 'NEW2'])
    // Exactly ONE create_blocks_batch call carrying both lines.
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]?.[1]).toMatchObject({
      specs: [
        expect.objectContaining({
          blockType: 'content',
          content: 'Morning standup',
          parentId: 'PARENT',
        }),
        expect.objectContaining({
          blockType: 'content',
          content: 'TODOs',
          parentId: 'PARENT',
        }),
      ],
    })
    // Anti-backslide guard: NO per-line `create_block` IPC fires.
    const perLineCreateCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(perLineCreateCalls).toHaveLength(0)
  })

  it('expands template variables on each line', async () => {
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW1', block_type: 'content', content: '' },
      { id: 'NEW2', block_type: 'content', content: '' },
    ])

    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const today = `${yyyy}-${mm}-${dd}`

    await insertTemplateBlocksFromString('Date: <% today %>\nPage: <% page title %>', 'PARENT', {
      pageTitle: 'My Daily',
    })

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    const specs = (batchCalls[0]?.[1] as { specs: Array<{ content: string }> }).specs
    expect(specs[0]?.content).toBe(`Date: ${today}`)
    expect(specs[1]?.content).toBe('Page: My Daily')
  })

  it('skips blank lines and surrounding whitespace', async () => {
    mockedInvoke.mockResolvedValueOnce([
      { id: 'NEW1', block_type: 'content', content: 'A' },
      { id: 'NEW2', block_type: 'content', content: 'B' },
    ])

    // Leading blank, trailing blank, internal blank line, whitespace-only line.
    const ids = await insertTemplateBlocksFromString('\n\n  \nA\n\n   \nB\n\n', 'PARENT')

    expect(ids).toEqual(['NEW1', 'NEW2'])
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    const specs = (batchCalls[0]?.[1] as { specs: Array<{ content: string }> }).specs
    expect(specs).toHaveLength(2)
  })

  it('returns empty list and logs a warning when the batch IPC fails', async () => {
    // PEND-35 Tier 4.3 — atomicity flipped from per-line to per-batch.
    // A batch failure rolls the whole template back; the wrapper logs
    // and returns `[]` rather than partially landing the prefix.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockedInvoke.mockRejectedValueOnce(new Error('batch insert failed'))

    const ids = await insertTemplateBlocksFromString('A\nB\nC', 'PARENT')

    expect(ids).toEqual([])
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('journal template batch insert failed'),
    )

    warnSpy.mockRestore()
  })

  it('returns an empty array for an empty template string without firing any IPC', async () => {
    const ids = await insertTemplateBlocksFromString('   \n\n  ', 'PARENT')
    expect(ids).toEqual([])
    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
    expect(batchCalls).toHaveLength(0)
    const perLineCreateCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(perLineCreateCalls).toHaveLength(0)
  })
})
