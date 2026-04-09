/**
 * Tests for block-utils — processCheckboxSyntax.
 *
 * Validates:
 * - TODO checkbox syntax detection (`- [ ] `)
 * - DONE checkbox syntax detection (`- [x] ` and `- [X] `)
 * - No match returns original content with null state
 * - Partial/malformed checkbox patterns are not matched
 */

import { describe, expect, it } from 'vitest'
import { processCheckboxSyntax } from '../block-utils'

describe('processCheckboxSyntax', () => {
  it('detects TODO checkbox and strips prefix', () => {
    const result = processCheckboxSyntax('- [ ] Buy groceries')
    expect(result).toEqual({ cleanContent: 'Buy groceries', todoState: 'TODO' })
  })

  it('detects DONE checkbox with lowercase x', () => {
    const result = processCheckboxSyntax('- [x] Buy groceries')
    expect(result).toEqual({ cleanContent: 'Buy groceries', todoState: 'DONE' })
  })

  it('detects DONE checkbox with uppercase X', () => {
    const result = processCheckboxSyntax('- [X] Buy groceries')
    expect(result).toEqual({ cleanContent: 'Buy groceries', todoState: 'DONE' })
  })

  it('returns null todoState for content without checkbox', () => {
    const result = processCheckboxSyntax('Just plain text')
    expect(result).toEqual({ cleanContent: 'Just plain text', todoState: null })
  })

  it('returns null todoState for empty string', () => {
    const result = processCheckboxSyntax('')
    expect(result).toEqual({ cleanContent: '', todoState: null })
  })

  it('does not match partial checkbox patterns', () => {
    expect(processCheckboxSyntax('- []')).toEqual({ cleanContent: '- []', todoState: null })
    expect(processCheckboxSyntax('[ ] text')).toEqual({ cleanContent: '[ ] text', todoState: null })
    expect(processCheckboxSyntax('-[ ] text')).toEqual({
      cleanContent: '-[ ] text',
      todoState: null,
    })
    expect(processCheckboxSyntax('- [ ]text')).toEqual({
      cleanContent: '- [ ]text',
      todoState: null,
    })
  })

  it('handles checkbox with empty content after prefix', () => {
    const result = processCheckboxSyntax('- [ ] ')
    expect(result).toEqual({ cleanContent: '', todoState: 'TODO' })
  })

  it('preserves content after checkbox prefix exactly', () => {
    const result = processCheckboxSyntax('- [x]   extra spaces')
    // '- [x] ' is 6 chars, so content starts at index 6
    expect(result).toEqual({ cleanContent: '  extra spaces', todoState: 'DONE' })
  })
})
