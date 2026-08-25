import { describe, expect, it } from 'vitest'

import { getPayloadPreview, getPayloadRawContent, getPropertyPayload } from '@/lib/history-utils'
import type { HistoryEntry } from '@/lib/tauri'

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

describe('getPayloadPreview', () => {
  it('returns to_text preview for edit_block payloads', () => {
    const entry = makeEntry(JSON.stringify({ to_text: 'Hello world' }))
    expect(getPayloadPreview(entry)).toBe('Hello world')
  })

  it('returns content preview for create_block payloads', () => {
    const entry = makeEntry(JSON.stringify({ content: 'New block content' }), 'create_block')
    expect(getPayloadPreview(entry)).toBe('New block content')
  })

  it('truncates at maxLen with "..."', () => {
    const longText = 'a'.repeat(150)
    const entry = makeEntry(JSON.stringify({ to_text: longText }))
    expect(getPayloadPreview(entry)).toBe(`${'a'.repeat(100)}...`)
  })

  it('does not truncate when under maxLen', () => {
    const shortText = 'a'.repeat(50)
    const entry = makeEntry(JSON.stringify({ to_text: shortText }))
    expect(getPayloadPreview(entry)).toBe(shortText)
  })

  it('returns null for invalid JSON', () => {
    const entry = makeEntry('not json at all')
    expect(getPayloadPreview(entry)).toBeNull()
  })

  it('returns null for payloads without to_text or content', () => {
    const entry = makeEntry(JSON.stringify({ other_field: 'value' }))
    expect(getPayloadPreview(entry)).toBeNull()
  })

  it('respects custom maxLen parameter', () => {
    const text = 'a'.repeat(30)
    const entry = makeEntry(JSON.stringify({ to_text: text }))
    expect(getPayloadPreview(entry, 20)).toBe(`${'a'.repeat(20)}...`)
  })

  it('handles empty strings', () => {
    const entry = makeEntry(JSON.stringify({ to_text: '' }))
    expect(getPayloadPreview(entry)).toBe('')
  })

  it('prefers to_text over content when both are present', () => {
    const entry = makeEntry(JSON.stringify({ to_text: 'edit text', content: 'create text' }))
    expect(getPayloadPreview(entry)).toBe('edit text')
  })

  it('does not truncate when exactly at maxLen', () => {
    const text = 'a'.repeat(100)
    const entry = makeEntry(JSON.stringify({ to_text: text }))
    expect(getPayloadPreview(entry)).toBe(text)
  })

  it('returns null when content is present but is not a string', () => {
    const entry = makeEntry(JSON.stringify({ content: 42 }), 'create_block')
    expect(getPayloadPreview(entry)).toBeNull()
  })

  it('truncates content (create_block payload) at maxLen with "..."', () => {
    const longText = 'b'.repeat(150)
    const entry = makeEntry(JSON.stringify({ content: longText }), 'create_block')
    expect(getPayloadPreview(entry)).toBe(`${'b'.repeat(100)}...`)
  })

  it('does not truncate content (create_block payload) when under maxLen', () => {
    const shortText = 'b'.repeat(50)
    const entry = makeEntry(JSON.stringify({ content: shortText }), 'create_block')
    expect(getPayloadPreview(entry)).toBe(shortText)
  })

  it('does not truncate content (create_block payload) when exactly at maxLen', () => {
    const text = 'b'.repeat(100)
    const entry = makeEntry(JSON.stringify({ content: text }), 'create_block')
    expect(getPayloadPreview(entry)).toBe(text)
  })
})

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
