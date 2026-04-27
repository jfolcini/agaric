/**
 * Tests for src/lib/query-result-utils.ts — resolveBlockDisplay & handleBlockNavigation.
 */

import { describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import { handleBlockNavigation, resolveBlockDisplay } from '../query-result-utils'

// ---------------------------------------------------------------------------
// resolveBlockDisplay
// ---------------------------------------------------------------------------
describe('resolveBlockDisplay', () => {
  it('returns the resolved block title and page title (happy path)', () => {
    const block = makeBlock({ id: 'b1', parent_id: 'p1', page_id: 'p1', content: 'raw content' })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue('Resolved Title')

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result).toEqual({ title: 'Resolved Title', pageTitle: 'My Page' })
    expect(resolveBlockTitle).toHaveBeenCalledWith('b1')
  })

  it('returns undefined pageTitle when page_id is null', () => {
    const block = makeBlock({ parent_id: null, page_id: null, content: 'some content' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.pageTitle).toBeUndefined()
  })

  it('returns undefined pageTitle when page_id is not in the map', () => {
    const block = makeBlock({ parent_id: 'unknown-page', page_id: 'unknown-page' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.pageTitle).toBeUndefined()
  })

  it('falls back to truncateContent when resolveBlockTitle returns empty string', () => {
    const block = makeBlock({ content: 'fallback content' })
    const pageTitles = new Map<string, string>()
    const resolveBlockTitle = vi.fn().mockReturnValue('')

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result.title).toBe('fallback content')
  })

  it('falls back to truncateContent when resolveBlockTitle is not provided', () => {
    const block = makeBlock({ content: 'plain content' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.title).toBe('plain content')
  })

  it('truncates long content to 80 characters when falling back', () => {
    const longContent = 'a'.repeat(100)
    const block = makeBlock({ content: longContent })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    // truncateContent(content, 80) appends "..." when content exceeds max
    expect(result.title).toBe(`${'a'.repeat(80)}...`)
  })
})

// ---------------------------------------------------------------------------
// handleBlockNavigation
// ---------------------------------------------------------------------------
describe('handleBlockNavigation', () => {
  it('calls onNavigate with page_id when both are present', () => {
    const block = makeBlock({ parent_id: 'page-42', page_id: 'page-42' })
    const onNavigate = vi.fn()

    handleBlockNavigation(block, onNavigate)

    expect(onNavigate).toHaveBeenCalledWith('page-42')
  })

  it('does not call onNavigate when page_id is null', () => {
    const block = makeBlock({ parent_id: null, page_id: null })
    const onNavigate = vi.fn()

    handleBlockNavigation(block, onNavigate)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does nothing when onNavigate is undefined', () => {
    const block = makeBlock({ parent_id: 'page-1', page_id: 'page-1' })

    // Should not throw
    expect(() => handleBlockNavigation(block, undefined)).not.toThrow()
  })

  it('does nothing when both page_id and onNavigate are missing', () => {
    const block = makeBlock({ parent_id: null, page_id: null })

    expect(() => handleBlockNavigation(block)).not.toThrow()
  })
})
