/**
 * Tests for the inline-image attachment-ref scheme (#1434).
 *
 * `attachment:<id>` is the internal `src` an inline image node carries after an
 * image is pasted/dropped and stored as an attachment. The ref must round-trip
 * (build → parse) and reject malformed/hostile shapes so a bad ref is never
 * forwarded to the backend at resolve time.
 */

import { describe, expect, it } from 'vitest'

import {
  ATTACHMENT_REF_SCHEME,
  attachmentRef,
  isAttachmentRef,
  parseAttachmentRef,
} from '../attachment-ref'

describe('attachmentRef / parseAttachmentRef (#1434)', () => {
  it('builds and parses an attachment ref round-trip', () => {
    const id = '01HZX9P3QABCDEF0123456789'
    const ref = attachmentRef(id)
    expect(ref).toBe(`${ATTACHMENT_REF_SCHEME}${id}`)
    expect(parseAttachmentRef(ref)).toBe(id)
  })

  it('isAttachmentRef recognizes the scheme with a non-empty id', () => {
    expect(isAttachmentRef('attachment:ATT1')).toBe(true)
    expect(isAttachmentRef('attachment:')).toBe(false)
    expect(isAttachmentRef('https://x.com/a.png')).toBe(false)
    expect(isAttachmentRef('/local/a.png')).toBe(false)
  })

  it('parseAttachmentRef returns null for a non-attachment src', () => {
    expect(parseAttachmentRef('https://x.com/a.png')).toBeNull()
    expect(parseAttachmentRef('data:image/png;base64,AAA')).toBeNull()
    expect(parseAttachmentRef('/c.png')).toBeNull()
    expect(parseAttachmentRef('')).toBeNull()
  })

  it('parseAttachmentRef returns null for an empty id', () => {
    expect(parseAttachmentRef('attachment:')).toBeNull()
  })

  it('parseAttachmentRef rejects ids with path-traversal / unsafe chars', () => {
    expect(parseAttachmentRef('attachment:../../etc/passwd')).toBeNull()
    expect(parseAttachmentRef('attachment:a/b')).toBeNull()
    expect(parseAttachmentRef('attachment:a b')).toBeNull()
    expect(parseAttachmentRef('attachment:a?b=1')).toBeNull()
    expect(parseAttachmentRef('attachment:a)b')).toBeNull()
  })

  it('accepts a real alphanumeric ULID-shaped id', () => {
    expect(parseAttachmentRef('attachment:01HZX9P3QABCDEF0123456789')).toBe(
      '01HZX9P3QABCDEF0123456789',
    )
  })
})
