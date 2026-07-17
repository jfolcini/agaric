/**
 * Unit tests for the inline `key:: value` property parser (#2675).
 *
 * The line-level rules mirror the Logseq import parser
 * (`src-tauri/src/import.rs`): split at the FIRST `":: "`, key must match
 * `^[A-Za-z0-9_-]{1,64}$`, value must be non-empty after trimming, reserved
 * keys and fenced code are skipped. Divergences (reserved keys stay literal
 * instead of being dropped) are documented in the module docstring.
 */

import { describe, expect, it } from 'vitest'

import type { PropertyDefinition } from '@/lib/tauri'

import {
  buildInlinePropertySetParams,
  INLINE_PROPERTY_RESERVED_KEYS,
  isInlinePropertyKey,
  parseInlineProperties,
  stripPropertyLines,
} from '../inline-property-parse'

function def(value_type: string, options: string | null = null): PropertyDefinition {
  return { key: 'k', value_type, options, created_at: '2026-01-01T00:00:00Z' }
}

describe('parseInlineProperties', () => {
  it('parses a single property line', () => {
    expect(parseInlineProperties('status:: active')).toEqual([
      { key: 'status', value: 'active', lineIndex: 0 },
    ])
  })

  it('parses multiple property lines and keeps their line indexes', () => {
    const content = 'some text\nstatus:: active\ncontext:: @office'
    expect(parseInlineProperties(content)).toEqual([
      { key: 'status', value: 'active', lineIndex: 1 },
      { key: 'context', value: '@office', lineIndex: 2 },
    ])
  })

  it('trims surrounding whitespace on the line, key, and value (import.rs parity)', () => {
    // import.rs trims the line, then trims each side of split_once(":: ").
    expect(parseInlineProperties('  status :: active  ')).toEqual([
      { key: 'status', value: 'active', lineIndex: 0 },
    ])
  })

  it('splits at the FIRST ":: " — the remainder stays in the value', () => {
    expect(parseInlineProperties('note:: this has :: inside')).toEqual([
      { key: 'note', value: 'this has :: inside', lineIndex: 0 },
    ])
  })

  it('accepts keys with digits, dashes, and underscores', () => {
    expect(parseInlineProperties('due-date_2:: tomorrow')).toEqual([
      { key: 'due-date_2', value: 'tomorrow', lineIndex: 0 },
    ])
  })

  it('rejects an invalid key (spaces / punctuation before ::)', () => {
    // Mid-sentence `:: ` — the LHS is not a valid key, so the line is content.
    expect(parseInlineProperties('see also:: the manual')).toEqual([])
    expect(parseInlineProperties('a URL https://x.test :: note')).toEqual([])
  })

  it('rejects `::` without a following space (std::vector never matches)', () => {
    expect(parseInlineProperties('std::vector<int> usage')).toEqual([])
    expect(parseInlineProperties('key::value')).toEqual([])
  })

  it('rejects a key longer than 64 chars', () => {
    const longKey = 'k'.repeat(65)
    expect(parseInlineProperties(`${longKey}:: v`)).toEqual([])
    const maxKey = 'k'.repeat(64)
    expect(parseInlineProperties(`${maxKey}:: v`)).toHaveLength(1)
  })

  it('rejects an empty value — `key:: ` then blur stays literal', () => {
    // The trimmed line is `key::`, which has no ":: " separator — exactly how
    // import.rs falls through to the content branch. The backend rejects
    // empty values, so the text must stay literal.
    expect(parseInlineProperties('status:: ')).toEqual([])
    expect(parseInlineProperties('status::')).toEqual([])
  })

  it('skips reserved / exporter-managed keys (they stay literal)', () => {
    for (const key of INLINE_PROPERTY_RESERVED_KEYS) {
      expect(parseInlineProperties(`${key}:: something`)).toEqual([])
    }
  })

  it('skips lines inside fenced code blocks', () => {
    const content = '```\nstatus:: active\n```'
    expect(parseInlineProperties(content)).toEqual([])
    // …but a property line AFTER the fence closes is parsed.
    const after = '```\nx:: y\n```\nstatus:: active'
    expect(parseInlineProperties(after)).toEqual([{ key: 'status', value: 'active', lineIndex: 3 }])
  })

  it('drops the hard-break marker `\\` from a non-final property line (serialized Shift+Enter)', () => {
    // `context:: home` + Shift+Enter + `notes` serializes to
    // `context:: home\` + '\n' + `notes` (markdown-serialize hardBreak).
    // The trailing `\` is the break marker, never part of the value.
    expect(parseInlineProperties('context:: home\\\nnotes')).toEqual([
      { key: 'context', value: 'home', lineIndex: 0 },
    ])
    // Two property lines joined by a hard break.
    expect(parseInlineProperties('a:: 1\\\nb:: 2')).toEqual([
      { key: 'a', value: '1', lineIndex: 0 },
      { key: 'b', value: '2', lineIndex: 1 },
    ])
  })

  it('keeps a LITERAL trailing backslash (escaped `\\\\`) in the value, minus the break marker', () => {
    // User-typed value `v\` serializes to `v\\`; with a following hard break
    // the line is `k:: v\\\` — only the final (odd) marker is dropped.
    expect(parseInlineProperties('k:: v\\\\\\\nnext')).toEqual([
      { key: 'k', value: 'v\\\\', lineIndex: 0 },
    ])
    // On the LAST line there is no break marker: `v\\` stays intact.
    expect(parseInlineProperties('k:: v\\\\')).toEqual([{ key: 'k', value: 'v\\\\', lineIndex: 0 }])
  })

  it('an empty-value property line before a hard break stays literal', () => {
    // `context:: ` + Shift+Enter → line `context:: \` → marker dropped →
    // `context::` → no ':: ' separator → not a property line.
    expect(parseInlineProperties('context:: \\\nmore text')).toEqual([])
  })

  it('returns an empty list for plain content', () => {
    expect(parseInlineProperties('just a normal block')).toEqual([])
    expect(parseInlineProperties('')).toEqual([])
  })
})

describe('isInlinePropertyKey', () => {
  it('matches the validate_set_property alphabet', () => {
    expect(isInlinePropertyKey('status')).toBe(true)
    expect(isInlinePropertyKey('a-b_C9')).toBe(true)
    expect(isInlinePropertyKey('')).toBe(false)
    expect(isInlinePropertyKey('has space')).toBe(false)
    expect(isInlinePropertyKey('émoji')).toBe(false)
    expect(isInlinePropertyKey('k'.repeat(65))).toBe(false)
  })
})

describe('stripPropertyLines', () => {
  it('removes only the given line indexes', () => {
    const content = 'text\nstatus:: active\nmore text'
    expect(stripPropertyLines(content, new Set([1]))).toBe('text\nmore text')
  })

  it('returns content unchanged for an empty index set', () => {
    const content = 'text\nstatus:: active'
    expect(stripPropertyLines(content, new Set())).toBe(content)
  })

  it('stripping the only line yields an empty string', () => {
    expect(stripPropertyLines('status:: active', new Set([0]))).toBe('')
  })

  it('supports stripping several lines while keeping the rest', () => {
    const content = 'a:: 1\nkeep me\nb:: 2'
    expect(stripPropertyLines(content, new Set([0, 2]))).toBe('keep me')
  })

  it('removes the dangling hard-break marker when the original LAST line is stripped', () => {
    // `notes` + Shift+Enter + `context:: home` serializes to
    // `notes\` + '\n' + `context:: home`; stripping line 1 must not leave the
    // now-final line as `notes\` (a stray literal backslash on reparse).
    expect(stripPropertyLines('notes\\\ncontext:: home', new Set([1]))).toBe('notes')
  })

  it('keeps an interior hard-break marker intact when a middle line is stripped', () => {
    // `a\` + `k:: v\` + `b` → strip line 1 → `a\` + `b`: the surviving marker
    // still has a following line, so it remains a valid hard break.
    expect(stripPropertyLines('a\\\nk:: v\\\nb', new Set([1]))).toBe('a\\\nb')
  })

  it('does not touch a literal double-backslash when the last line is stripped', () => {
    // `end\\` is an ESCAPED literal backslash (even run) — not a break marker.
    expect(stripPropertyLines('end\\\\\nk:: v', new Set([1]))).toBe('end\\\\')
  })
})

describe('buildInlinePropertySetParams', () => {
  it('stores value_text when there is no definition', () => {
    expect(buildInlinePropertySetParams('B', 'status', 'active', null)).toEqual({
      blockId: 'B',
      key: 'status',
      valueText: 'active',
    })
  })

  it('stores value_text for text and select definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'v', def('text'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueText: 'v',
    })
    expect(buildInlinePropertySetParams('B', 'k', 'alpha', def('select', '["alpha"]'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueText: 'alpha',
    })
  })

  it('parses numbers for number definitions and rejects unparseable values', () => {
    expect(buildInlinePropertySetParams('B', 'k', '42.5', def('number'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueNum: 42.5,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'not-a-number', def('number'))).toBeNull()
  })

  it('accepts only the YYYY-MM-DD storage shape for date definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', '2026-07-17', def('date'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueDate: '2026-07-17',
    })
    // The backend only rejects EMPTY value_date (validate_set_property), so
    // free text must be rejected HERE or a garbage date reaches agenda code.
    expect(buildInlinePropertySetParams('B', 'k', 'tomorrow', def('date'))).toBeNull()
    expect(buildInlinePropertySetParams('B', 'k', '17/07/2026', def('date'))).toBeNull()
  })

  it('accepts only exact true/false for boolean definitions', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'true', def('boolean'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueBool: true,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'false', def('boolean'))).toEqual({
      blockId: 'B',
      key: 'k',
      valueBool: false,
    })
    expect(buildInlinePropertySetParams('B', 'k', 'yes', def('boolean'))).toBeNull()
  })

  it('rejects ref definitions (inline text cannot express a page ref)', () => {
    expect(buildInlinePropertySetParams('B', 'k', 'Some Page', def('ref'))).toBeNull()
  })
})
