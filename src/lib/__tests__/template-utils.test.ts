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
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'T1', block_type: 'page', content: 'Meeting Notes' },
        { id: 'T2', block_type: 'page', content: 'Bug Report' },
        { id: 'B1', block_type: 'content', content: 'Not a page' },
      ],
      next_cursor: null,
      has_more: false,
    })

    const result = await loadTemplatePages(null)

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'template',
      valueText: 'true',
      valueDate: null,
      operator: null,
      cursor: null,
      limit: 100,
      spaceId: null,
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
  it('creates blocks from template children', async () => {
    // listBlocks(TMPL) → 2 children
    mockedInvoke.mockResolvedValueOnce({
      items: [
        {
          id: 'TC1',
          block_type: 'content',
          content: '## Attendees',
          parent_id: 'TMPL',
          position: 0,
        },
        { id: 'TC2', block_type: 'content', content: '## Agenda', parent_id: 'TMPL', position: 1 },
      ],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for TC1 → NEW1
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW1',
      block_type: 'content',
      content: '## Attendees',
    })
    // listBlocks(TC1) → no grandchildren
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for TC2 → NEW2
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW2', block_type: 'content', content: '## Agenda' })
    // listBlocks(TC2) → no grandchildren
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    expect(ids).toEqual(['NEW1', 'NEW2'])
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({
        parentId: 'TMPL',
        limit: 500,
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        content: '## Attendees',
        parentId: 'PARENT',
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        content: '## Agenda',
        parentId: 'PARENT',
      }),
    )
  })

  it('insertTemplateBlocks copies nested children recursively', async () => {
    // listBlocks(TMPL) → 1 child (A)
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'A', block_type: 'content', content: 'Heading A', parent_id: 'TMPL', position: 0 },
      ],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for A → NEW_A
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_A',
      block_type: 'content',
      content: 'Heading A',
    })
    // listBlocks(A) → 1 grandchild (B)
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'B', block_type: 'content', content: 'Sub-bullet B', parent_id: 'A', position: 0 },
      ],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for B → NEW_B (parentId should be NEW_A)
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_B',
      block_type: 'content',
      content: 'Sub-bullet B',
    })
    // listBlocks(B) → no children
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    // Both blocks were created
    expect(ids).toEqual(['NEW_A', 'NEW_B'])

    // createBlock was called exactly twice
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(2)

    // B's copy has the correct parentId (A's copy's ID)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        content: 'Sub-bullet B',
        parentId: 'NEW_A',
      }),
    )

    // listBlocks was called 3 times (template children, A's children, B's children)
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listCalls).toHaveLength(3)
  })

  it('continues copying after a single block creation failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // listBlocks(TMPL) → 3 children (A, B, C)
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'A', block_type: 'content', content: 'Block A', parent_id: 'TMPL', position: 0 },
        { id: 'B', block_type: 'content', content: 'Block B', parent_id: 'TMPL', position: 1 },
        { id: 'C', block_type: 'content', content: 'Block C', parent_id: 'TMPL', position: 2 },
      ],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for A → NEW_A (success)
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_A',
      block_type: 'content',
      content: 'Block A',
    })
    // listBlocks(A) → no children
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })
    // createBlock for B → FAIL
    mockedInvoke.mockRejectedValueOnce(new Error('create_block failed'))
    // createBlock for C → NEW_C (success)
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_C',
      block_type: 'content',
      content: 'Block C',
    })
    // listBlocks(C) → no children
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    // B was skipped; A and C were created
    expect(ids).toEqual(['NEW_A', 'NEW_C'])
    expect(ids).toHaveLength(2)

    // createBlock was called 3 times (A success, B fail, C success)
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(3)

    // Warning was logged for the failed block (via structured logger)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('template block copy failed; skipping'),
    )
    // Source block id is included as structured context
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"sourceBlockId":"B"'))

    warnSpy.mockRestore()
  })

  it('returns empty array when template has no children', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT', null)

    expect(ids).toEqual([])
    // Only the list_blocks call should happen
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
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
    // Mock list_blocks(T1) → 1 child
    mockedInvoke.mockResolvedValueOnce({
      items: [
        { id: 'C1', block_type: 'content', content: '## Attendees', parent_id: 'T1', position: 0 },
      ],
      next_cursor: null,
      has_more: false,
    })

    const result = await loadTemplatePagesWithPreview(null)
    expect(result).toHaveLength(1)
    expect(result[0]?.preview).toBe('## Attendees')
  })

  it('returns null preview when template has no children', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'T1', block_type: 'page', content: 'Empty Template' }],
      next_cursor: null,
      has_more: false,
    })
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

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
      items: [
        { id: 'C1', block_type: 'content', content: longContent, parent_id: 'T1', position: 0 },
      ],
      next_cursor: null,
      has_more: false,
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
    mockedInvoke.mockRejectedValueOnce(new Error('list_blocks failed'))

    const result = await loadTemplatePagesWithPreview(null)
    expect(result[0]?.preview).toBeNull()
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
    mockedInvoke.mockResolvedValueOnce([
      // unrelated rows only
      {
        key: 'accent_color',
        value_text: 'accent-blue',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
      { key: 'is_space', value_text: 'true', value_num: null, value_date: null, value_ref: null },
    ])

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: 'SPACE_1' })
  })

  it('returns value_text when journal_template is set', async () => {
    mockedInvoke.mockResolvedValueOnce([
      {
        key: 'journal_template',
        value_text: '## Standup\n- TODOs',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
    ])

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBe('## Standup\n- TODOs')
  })

  it('ignores rows for other keys when finding journal_template', async () => {
    mockedInvoke.mockResolvedValueOnce([
      {
        key: 'accent_color',
        value_text: 'accent-rose',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
      {
        key: 'journal_template',
        value_text: 'Daily focus',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
      { key: 'is_space', value_text: 'true', value_num: null, value_date: null, value_ref: null },
    ])

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBe('Daily focus')
  })

  it('returns null when value_text is null', async () => {
    mockedInvoke.mockResolvedValueOnce([
      {
        key: 'journal_template',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
      },
    ])

    const result = await loadJournalTemplateForSpace('SPACE_1')

    expect(result).toBeNull()
  })
})

describe('insertTemplateBlocksFromString', () => {
  it('creates one block per non-empty line', async () => {
    // createBlock for line 1
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW1',
      block_type: 'content',
      content: 'Morning standup',
    })
    // createBlock for line 2
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW2',
      block_type: 'content',
      content: 'TODOs',
    })

    const ids = await insertTemplateBlocksFromString('Morning standup\nTODOs', 'PARENT')

    expect(ids).toEqual(['NEW1', 'NEW2'])
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(2)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'content',
        content: 'Morning standup',
        parentId: 'PARENT',
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'content',
        content: 'TODOs',
        parentId: 'PARENT',
      }),
    )
  })

  it('expands template variables on each line', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW1', block_type: 'content', content: '' })
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW2', block_type: 'content', content: '' })

    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const today = `${yyyy}-${mm}-${dd}`

    await insertTemplateBlocksFromString('Date: <% today %>\nPage: <% page title %>', 'PARENT', {
      pageTitle: 'My Daily',
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: `Date: ${today}` }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: 'Page: My Daily' }),
    )
  })

  it('skips blank lines and surrounding whitespace', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW1', block_type: 'content', content: 'A' })
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW2', block_type: 'content', content: 'B' })

    // Leading blank, trailing blank, internal blank line, whitespace-only line.
    const ids = await insertTemplateBlocksFromString('\n\n  \nA\n\n   \nB\n\n', 'PARENT')

    expect(ids).toEqual(['NEW1', 'NEW2'])
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(2)
  })

  it('continues on per-line errors and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First line fails, second succeeds, third succeeds.
    mockedInvoke.mockRejectedValueOnce(new Error('create_block failed'))
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW2', block_type: 'content', content: 'B' })
    mockedInvoke.mockResolvedValueOnce({ id: 'NEW3', block_type: 'content', content: 'C' })

    const ids = await insertTemplateBlocksFromString('A\nB\nC', 'PARENT')

    expect(ids).toEqual(['NEW2', 'NEW3'])
    // Three create_block calls (one failed, two succeeded).
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(3)
    // The structured logger emits a single warn for the failed line.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('journal template line insert failed; skipping'),
    )

    warnSpy.mockRestore()
  })

  it('returns an empty array for an empty template string', async () => {
    const ids = await insertTemplateBlocksFromString('   \n\n  ', 'PARENT')
    expect(ids).toEqual([])
    const createCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createCalls).toHaveLength(0)
  })
})
