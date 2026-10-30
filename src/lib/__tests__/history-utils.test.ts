import { describe, expect, it } from 'vitest'

import type { HistoryEntry } from '@/lib/bindings'
import { getPayloadRawContent, getPropertyPayload, parsePayloadObject } from '@/lib/history-utils'

function makeEntry(payload: string, opType = 'edit_block'): HistoryEntry {
  return {
    device_id: 'dev-1',
    seq: 1,
    op_type: opType,
    payload,
    created_at: 1704067200000,
    is_replicated: false,
  }
}

describe('getPayloadRawContent', () => {
  it('returns to_text without truncation', () => {
    const longText = 'a'.repeat(500)
    const entry = makeEntry(JSON.stringify({ to_text: longText }))
    expect(getPayloadRawContent(entry)).toBe(longText)
  })

  it('returns content when to_text is absent', () => {
    const entry = makeEntry(JSON.stringify({ content: 'New block' }), 'create_block')
    expect(getPayloadRawContent(entry)).toBe('New block')
  })

  it('prefers to_text over content', () => {
    const entry = makeEntry(JSON.stringify({ to_text: 'edit', content: 'create' }))
    expect(getPayloadRawContent(entry)).toBe('edit')
  })

  it('returns null for invalid JSON', () => {
    const entry = makeEntry('not json')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null when no text fields exist', () => {
    const entry = makeEntry(JSON.stringify({ other: 'value' }))
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('preserves ULID tokens in raw content', () => {
    const text = 'See [[01ARZ3NDEKTSV4RRFFQ69G5FAV]] and #[01CRZ3NDEKTSV4RRFFQ69G5FAV]'
    const entry = makeEntry(JSON.stringify({ to_text: text }))
    expect(getPayloadRawContent(entry)).toBe(text)
  })

  // -- #4335 review: attachment payloads (neither carries to_text/content) --

  it('returns the filename for a delete_attachment payload', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', fs_path: 'attachments/x', filename: 'notes.pdf' }),
      'delete_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('notes.pdf')
  })

  it('returns null for a delete_attachment payload with no filename (pre-#4262 legacy row)', () => {
    const entry = makeEntry(JSON.stringify({ attachment_id: 'ATT1' }), 'delete_attachment')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null for a delete_attachment payload whose filename is an empty string', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', filename: '' }),
      'delete_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null when a delete_attachment filename is not a string', () => {
    // The `typeof` half of the guard is what keeps the return type
    // `string | null`: a non-string value with a truthy `.length` (an array
    // here) satisfies the `.length > 0` half on its own.
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', filename: ['notes.pdf'] }),
      'delete_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns the filename for an add_attachment payload', () => {
    const entry = makeEntry(
      JSON.stringify({
        attachment_id: 'ATT1',
        block_id: 'BLK1',
        mime_type: 'application/pdf',
        filename: 'notes.pdf',
        size_bytes: 100,
        fs_path: 'attachments/x',
      }),
      'add_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('notes.pdf')
  })

  it('returns null for an add_attachment payload whose filename is an empty string', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', block_id: 'BLK1', filename: '' }),
      'add_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null for an add_attachment payload with no filename', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', block_id: 'BLK1' }),
      'add_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null when an add_attachment filename is not a string', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', block_id: 'BLK1', filename: ['notes.pdf'] }),
      'add_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('renders a stray filename only for the attachment op types', () => {
    // The add_attachment arm is gated on op_type, not on the presence of a
    // `filename` field: a non-attachment op that happens to carry one must
    // not be rendered as if it were an attachment row.
    const entry = makeEntry(
      JSON.stringify({ block_id: 'BLK1', filename: 'notes.pdf' }),
      'move_block',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns the alias of an add_page_alias or remove_page_alias payload', () => {
    const payload = JSON.stringify({ page_id: 'PG1', alias: '#plans' })
    expect(getPayloadRawContent(makeEntry(payload, 'add_page_alias'))).toBe('#plans')
    expect(getPayloadRawContent(makeEntry(payload, 'remove_page_alias'))).toBe('#plans')
  })

  it('returns the key of a set_property_def payload', () => {
    const payload = JSON.stringify({ space_id: 'SP1', key: 'effort', def: null, prior: null })
    expect(getPayloadRawContent(makeEntry(payload, 'set_property_def'))).toBe('effort')
  })

  it('returns old → new for a rename_property_key payload', () => {
    const payload = JSON.stringify({ space_id: 'SP1', old_key: 'project', new_key: 'area' })
    expect(getPayloadRawContent(makeEntry(payload, 'rename_property_key'))).toBe('project → area')
  })

  it('returns the merged keys, from → into, for a rewrite_properties payload', () => {
    const def = { value_type: 'select', options: '["a"]' }
    const payload = JSON.stringify({
      space_id: 'SP1',
      reason: 'merge',
      defs: [
        { key: 'stage', def: null, prior: def },
        { key: 'phase', def, prior: def },
      ],
      values: [],
    })
    expect(getPayloadRawContent(makeEntry(payload, 'rewrite_properties'))).toBe('stage → phase')
  })

  it('returns key: from → to for a type change', () => {
    const payload = JSON.stringify({
      space_id: 'SP1',
      reason: 'change_type',
      defs: [
        {
          key: 'effort',
          def: { value_type: 'number', options: null },
          prior: { value_type: 'text', options: null },
        },
      ],
      values: [],
    })
    expect(getPayloadRawContent(makeEntry(payload, 'rewrite_properties'))).toBe(
      'effort: text → number',
    )
  })

  it('returns null for a type change without both types', () => {
    const payload = JSON.stringify({
      space_id: 'SP1',
      reason: 'change_type',
      defs: [{ key: 'effort', def: { value_type: 'number', options: null }, prior: null }],
      values: [],
    })
    expect(getPayloadRawContent(makeEntry(payload, 'rewrite_properties'))).toBeNull()
  })

  it('returns null for a set_property_def payload without a key', () => {
    const payload = JSON.stringify({ space_id: 'SP1', def: null, prior: null })
    expect(getPayloadRawContent(makeEntry(payload, 'set_property_def'))).toBeNull()
  })

  it('returns null for an alias payload whose alias is an empty string', () => {
    const entry = makeEntry(JSON.stringify({ page_id: 'PG1', alias: '' }), 'add_page_alias')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns null when an alias is not a string', () => {
    const entry = makeEntry(JSON.stringify({ page_id: 'PG1', alias: ['#plans'] }), 'add_page_alias')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('renders a stray alias only for the alias op types', () => {
    const entry = makeEntry(JSON.stringify({ block_id: 'BLK1', alias: '#plans' }), 'move_block')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  it('returns the old → new transition for a rename_attachment payload', () => {
    const entry = makeEntry(
      JSON.stringify({
        attachment_id: 'ATT1',
        old_filename: 'draft.txt',
        new_filename: 'final.txt',
      }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('draft.txt → final.txt')
  })

  it('falls back to the new filename when a rename_attachment payload is missing old_filename', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', new_filename: 'final.txt' }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('final.txt')
  })

  it('falls back to the old filename when a rename_attachment payload is missing new_filename', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', old_filename: 'draft.txt' }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('draft.txt')
  })

  it('returns null for a rename_attachment payload with neither filename', () => {
    const entry = makeEntry(JSON.stringify({ attachment_id: 'ATT1' }), 'rename_attachment')
    expect(getPayloadRawContent(entry)).toBeNull()
  })

  // -- #4335 review: `""` is a string, so `??` alone doesn't treat it as
  // absent (unlike `undefined`/`null`) — mirrors the `filename.length > 0`
  // guard the delete_attachment arm already has, just above.

  it('falls back to the new filename when a rename_attachment payload has an empty old_filename', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', old_filename: '', new_filename: 'final.txt' }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('final.txt')
  })

  it('falls back to the old filename when a rename_attachment payload has an empty new_filename', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', old_filename: 'draft.txt', new_filename: '' }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBe('draft.txt')
  })

  it('returns null for a rename_attachment payload where both filenames are empty strings', () => {
    const entry = makeEntry(
      JSON.stringify({ attachment_id: 'ATT1', old_filename: '', new_filename: '' }),
      'rename_attachment',
    )
    expect(getPayloadRawContent(entry)).toBeNull()
  })
})

describe('getPropertyPayload', () => {
  it('extracts key and value from set_property', () => {
    const entry = makeEntry(
      JSON.stringify({ key: 'due_date', value: '2026-04-15' }),
      'set_property',
    )
    expect(getPropertyPayload(entry)).toEqual({ key: 'due_date', value: '2026-04-15' })
  })

  it('extracts key without value from delete_property', () => {
    const entry = makeEntry(JSON.stringify({ key: 'due_date' }), 'delete_property')
    expect(getPropertyPayload(entry)).toEqual({ key: 'due_date' })
  })

  it('returns null for non-property op types', () => {
    const entry = makeEntry(JSON.stringify({ key: 'due_date' }), 'edit_block')
    expect(getPropertyPayload(entry)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    const entry = makeEntry('bad json', 'set_property')
    expect(getPropertyPayload(entry)).toBeNull()
  })

  it('returns null when key is missing', () => {
    const entry = makeEntry(JSON.stringify({ value: '2026-04-15' }), 'set_property')
    expect(getPropertyPayload(entry)).toBeNull()
  })

  it('excludes value from the result when present but not a string', () => {
    const entry = makeEntry(JSON.stringify({ key: 'due_date', value: 42 }), 'set_property')
    expect(getPropertyPayload(entry)).toEqual({ key: 'due_date' })
  })
})

/**
 * #3756 EQUIVALENCE LEDGER — `history-utils.ts` mutants no input can distinguish.
 *
 * 7:42 [ConditionalExpression] `parsed !== null` -> true — `typeof null` is
 *   `'object'` and `Array.isArray(null)` is false, so a `null` payload takes the
 *   true arm and returns `parsed`, which is that same `null`. The operand stays:
 *   it narrows `object | null` to `object`, so the cast does not hide a `null`.
 */
describe('parsePayloadObject', () => {
  it('returns the parsed object for an object payload', () => {
    expect(parsePayloadObject('{"block_id":"B1"}')).toEqual({ block_id: 'B1' })
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['a number', '3'],
  ])('returns null for %s', (_label, payload) => {
    expect(parsePayloadObject(payload)).toBeNull()
  })
})
