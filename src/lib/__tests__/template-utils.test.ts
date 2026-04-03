import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTemplateBlocks, loadJournalTemplate, loadTemplatePages } from '../template-utils'

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

    const result = await loadTemplatePages()

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'template',
      valueText: 'true',
      valueDate: null,
      cursor: null,
      limit: 100,
    })
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('T1')
    expect(result[1].id).toBe('T2')
  })

  it('returns empty array when no templates exist', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const result = await loadTemplatePages()
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

    const ids = await insertTemplateBlocks('TMPL', 'PARENT')

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

    const ids = await insertTemplateBlocks('TMPL', 'PARENT')

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

  it('returns empty array when template has no children', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const ids = await insertTemplateBlocks('TMPL', 'PARENT')

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

    const result = await loadJournalTemplate()

    expect(result).not.toBeNull()
    expect(result?.id).toBe('JT1')
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

    const result = await loadJournalTemplate()
    expect(result).toBeNull()
  })
})
