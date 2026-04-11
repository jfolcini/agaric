import { describe, expect, it } from 'vitest'
import { getPayloadPreview, getPayloadRawContent, getPropertyPayload } from '../history-utils'
import type { HistoryEntry } from '../tauri'

function makeEntry(payload: string, opType = 'edit_block'): HistoryEntry {
  return {
    device_id: 'dev-1',
    seq: 1,
    op_type: opType,
    payload,
    created_at: '2024-01-01T00:00:00Z',
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
})
