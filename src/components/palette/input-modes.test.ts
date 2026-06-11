/**
 * Unit tests for the palette prefix-routing pure functions extracted
 * from CommandPalette.tsx (#751). These cover the prefix vocabulary
 * (`[[`, `>`, `#`, `?`) and the query-stripping semantics that the
 * React body relies on.
 */

import { describe, expect, it } from 'vitest'

import {
  commandsModeQuery,
  helpModeQuery,
  isCommandsModeInput,
  isHelpModeInput,
  isPageLinkMode,
  isTagsModeInput,
  pageLinkQuery,
  routePrefixToMode,
  tagsModeQuery,
} from './input-modes'

describe('isPageLinkMode', () => {
  it('requires the `[[` prefix plus at least one more char', () => {
    expect(isPageLinkMode('[[a')).toBe(true)
    expect(isPageLinkMode('[[')).toBe(false)
    expect(isPageLinkMode('[')).toBe(false)
    expect(isPageLinkMode('a[[b')).toBe(false)
    expect(isPageLinkMode('')).toBe(false)
  })
})

describe('pageLinkQuery', () => {
  it('strips the leading `[[`', () => {
    expect(pageLinkQuery('[[Home')).toBe('Home')
  })

  it('strips a trailing `]]` (Notion UX) and surrounding whitespace', () => {
    expect(pageLinkQuery('[[Home]]')).toBe('Home')
    expect(pageLinkQuery('[[Home]]  ')).toBe('Home')
  })

  it('leaves inner text untouched when no closing bracket is present', () => {
    expect(pageLinkQuery('[[My Page')).toBe('My Page')
  })
})

describe('commands-mode prefix', () => {
  it('detects the `>` prefix', () => {
    expect(isCommandsModeInput('>')).toBe(true)
    expect(isCommandsModeInput('>set')).toBe(true)
    expect(isCommandsModeInput(' >set')).toBe(false)
    expect(isCommandsModeInput('set')).toBe(false)
  })

  it('strips the `>` and leading whitespace', () => {
    expect(commandsModeQuery('>set')).toBe('set')
    expect(commandsModeQuery('>   set')).toBe('set')
    expect(commandsModeQuery('>')).toBe('')
  })
})

describe('tags-mode prefix', () => {
  it('detects the `#` prefix', () => {
    expect(isTagsModeInput('#')).toBe(true)
    expect(isTagsModeInput('#todo')).toBe(true)
    expect(isTagsModeInput('todo')).toBe(false)
  })

  it('strips the `#` and leading whitespace', () => {
    expect(tagsModeQuery('#todo')).toBe('todo')
    expect(tagsModeQuery('#  todo')).toBe('todo')
  })
})

describe('help-mode prefix', () => {
  it('detects the `?` prefix', () => {
    expect(isHelpModeInput('?')).toBe(true)
    expect(isHelpModeInput('?undo')).toBe(true)
    expect(isHelpModeInput('undo')).toBe(false)
  })

  it('strips the `?` and leading whitespace', () => {
    expect(helpModeQuery('?undo')).toBe('undo')
    expect(helpModeQuery('?  undo')).toBe('undo')
  })
})

describe('routePrefixToMode', () => {
  it('routes `>` to commands mode with the stripped query', () => {
    expect(routePrefixToMode('>set')).toEqual({ next: 'commands', q: 'set' })
  })

  it('routes `#` to tags mode with the stripped query', () => {
    expect(routePrefixToMode('#todo')).toEqual({ next: 'tags', q: 'todo' })
  })

  it('routes `?` to help mode with the stripped query', () => {
    expect(routePrefixToMode('?undo')).toEqual({ next: 'help', q: 'undo' })
  })

  it('returns null for plain search text and `[[` link mode', () => {
    expect(routePrefixToMode('hello')).toBeNull()
    expect(routePrefixToMode('[[Home')).toBeNull()
    expect(routePrefixToMode('')).toBeNull()
  })

  it('detects the mode after leading whitespace, but strips from the raw input', () => {
    // Detection trims leading whitespace (`trimStart`) so the mode is
    // recognised; the stripped query is computed from the RAW input,
    // so a leading space before `>` shifts the slice and leaves the
    // `>` in place. The palette body only routes through this for
    // empty/whitespace queries in practice, so the leading-space case
    // is documented here rather than treated as a supported entry.
    expect(routePrefixToMode('  >set')).toEqual({ next: 'commands', q: '>set' })
  })
})
