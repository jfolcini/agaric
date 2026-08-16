/**
 * Tests for block-utils — processCheckboxSyntax.
 *
 * Validates:
 * - TODO checkbox syntax detection (`- [ ] `)
 * - DONE checkbox syntax detection (`- [x] ` and `- [X] `)
 * - No match returns original content with null state
 * - Partial/malformed checkbox patterns are not matched
 * INTERNAL_PROPERTY_KEYS membership
 */

import { describe, expect, it } from 'vitest'

import { MAX_MARKER_INDENT, TASK_ITEM_RE } from '@/editor/markdown-parse/vocab'
import { INTERNAL_PROPERTY_KEYS, processCheckboxSyntax } from '@/lib/block-utils'

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

  // #1481 — fold the full task-state vocabulary (DOING/CANCELLED + `*` marker),
  // matching the markdown serialize/parse layer (#1435).
  it('detects DOING checkbox `- [/] `', () => {
    expect(processCheckboxSyntax('- [/] in progress')).toEqual({
      cleanContent: 'in progress',
      todoState: 'DOING',
    })
  })

  it('detects CANCELLED checkbox `- [-] `', () => {
    expect(processCheckboxSyntax('- [-] dropped')).toEqual({
      cleanContent: 'dropped',
      todoState: 'CANCELLED',
    })
  })

  it('accepts the `*` task marker', () => {
    expect(processCheckboxSyntax('* [ ] star task')).toEqual({
      cleanContent: 'star task',
      todoState: 'TODO',
    })
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

  // -- #4019 follow-up: agree with the parser's marker-indent tolerance -------
  // `TASK_ITEM_RE` tolerates up to `MAX_MARKER_INDENT` spaces before the
  // marker, so an indented task line already RENDERS as a task; without the
  // same tolerance here it never folded into the `todo_state` column and the
  // marker stayed in `content`. Like the parser, the tolerated indent is part
  // of the marker, not of the task text.
  describe('marker-indent tolerance agrees with the markdown parser', () => {
    const TOLERATED = Array.from({ length: MAX_MARKER_INDENT + 1 }, (_, n) => ' '.repeat(n))

    it.each(TOLERATED)('folds a task marker indented by %j', (pad) => {
      expect(processCheckboxSyntax(`${pad}- [ ] buy milk`)).toEqual({
        cleanContent: 'buy milk',
        todoState: 'TODO',
      })
      expect(processCheckboxSyntax(`${pad}* [x] done`)).toEqual({
        cleanContent: 'done',
        todoState: 'DONE',
      })
    })

    it('one space past the tolerance is plain content', () => {
      const pad = ' '.repeat(MAX_MARKER_INDENT + 1)
      expect(processCheckboxSyntax(`${pad}- [ ] buy milk`)).toEqual({
        cleanContent: `${pad}- [ ] buy milk`,
        todoState: null,
      })
    })

    it.each(TOLERATED)('matches TASK_ITEM_RE on the same string (indent %j)', (pad) => {
      const line = `${pad}- [/] doing`
      expect(TASK_ITEM_RE.test(line)).toBe(true)
      expect(processCheckboxSyntax(line).todoState).toBe('DOING')
    })
  })
})

describe('INTERNAL_PROPERTY_KEYS', () => {
  it('contains exactly the 5 expected keys', () => {
    expect(INTERNAL_PROPERTY_KEYS.size).toBe(5)
    expect([...INTERNAL_PROPERTY_KEYS].toSorted()).toEqual(
      ['repeat', 'created_at', 'completed_at', 'repeat-seq', 'repeat-origin'].toSorted(),
    )
  })

  it('returns true for an internal key (`repeat`)', () => {
    expect(INTERNAL_PROPERTY_KEYS.has('repeat')).toBe(true)
  })

  it('returns false for `todo_state` (lives in NON_DELETABLE_PROPERTIES, not here)', () => {
    expect(INTERNAL_PROPERTY_KEYS.has('todo_state')).toBe(false)
  })
})
