/**
 * #3893 — unit tests for the TS half of the conformance cursor-shape
 * projection.
 *
 * `cursorShape` is a hand-mirrored twin of `shape_of_cursor` in
 * `src-tauri/tests/command_integration/conformance_query.rs`, and the twin
 * relationship is the whole mechanism: the backend AUTHORS each fixture's
 * `cursor` field and the mock leg must reproduce it byte-for-byte, so a
 * rendering difference between the two functions is a harness lie rather than a
 * detected divergence.
 *
 * Every case below has a same-named sibling in the Rust `cursor_shape_tests`
 * module and asserts the SAME output string. Only the well-formed cases are
 * reachable through the fixtures — the malformed ones exist because they are
 * what makes the guard a guard: if a codec change on either side rendered as
 * something tolerant instead of a marker, the fixtures would keep agreeing.
 */

import { describe, expect, it } from 'vitest'

import { cursorShape } from '@/lib/tauri-mock/__tests__/conformance-query'

/**
 * `URL_SAFE_NO_PAD.encode(json.as_bytes())`, hand-rolled over `TextEncoder`
 * bytes rather than borrowed from `@/lib/base64url` — the same
 * non-tautology rule the #3888 cursor test follows. If the shared codec and
 * `cursorShape` ever drifted together, a shared helper here would drift with
 * them and the test would keep passing.
 */
function encode(json: string): string {
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = new TextEncoder().encode(json)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64URL[b0 >> 2] ?? ''
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? ''
    if (b1 === undefined) break
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? ''
    if (b2 === undefined) break
    out += B64URL[b2 & 0x3f] ?? ''
  }
  return out
}

describe('cursorShape — the engine tuple cursor (QueryCursor)', () => {
  it('renders version and ordered tags', () => {
    expect(
      cursorShape(encode('{"version":1,"values":[{"t":"Int","v":3},{"t":"Text","v":"01ABC"}]}')),
    ).toBe('v1:[Int,Text]')
  })

  // The tuple is ORDERED, so a reordered sort key is a different shape. A
  // sorted rendering would make the reorder invisible — half of the #3893
  // failure class.
  it('treats a reordered sort tuple as a different shape', () => {
    expect(
      cursorShape(encode('{"version":1,"values":[{"t":"Int","v":3},{"t":"Text","v":"a"}]}')),
    ).not.toBe(
      cursorShape(encode('{"version":1,"values":[{"t":"Text","v":"a"},{"t":"Int","v":3}]}')),
    )
  })

  // The #3863 shape exactly: the pre-fix mock carried the id ALONE where the
  // engine carries the whole tagged tuple. Arity alone separates them.
  it('separates a one-term tuple from a two-term tuple', () => {
    expect(cursorShape(encode('{"version":1,"values":[{"t":"Text","v":"a"}]}'))).toBe('v1:[Text]')
  })

  // A field added ALONGSIDE `values` is a cursor-format change, and the tuple
  // branch used to discard every key it did not name — so `QueryCursor` growing
  // a sort fingerprint or a direction flag would have left the shape identical.
  it('sees a sibling field added next to the tuple', () => {
    expect(cursorShape(encode('{"version":1,"values":[{"t":"Text","v":"a"}],"desc":true}'))).toBe(
      'v1:[Text]+{desc}',
    )
    // Empty suffix for today's two-key cursor, so no fixture moved when this
    // was added — the guard is free until the format actually changes.
    expect(cursorShape(encode('{"version":1,"values":[{"t":"Text","v":"a"}]}'))).toBe('v1:[Text]')
  })

  it('sees a version bump', () => {
    expect(cursorShape(encode('{"version":2,"values":[{"t":"Text","v":"a"}]}'))).toBe('v2:[Text]')
  })
})

describe('cursorShape — the pagination cursor (Cursor)', () => {
  // The backend's `Cursor` optional slots are `skip_serializing_if =
  // "Option::is_none"`, so which slots are PRESENT is which keyset the page was
  // minted on.
  it('renders its populated slots, sorted', () => {
    expect(cursorShape(encode('{"id":"01ABC","position":3,"version":1}'))).toBe('v1:{id,position}')
    expect(cursorShape(encode('{"id":"01ABC","version":1}'))).toBe('v1:{id}')
  })

  // Serde field order is a byte-level detail, not a keyset — two encoders that
  // populate the same slots in a different declaration order describe the same
  // page boundary and must not redden.
  it('is insensitive to the key order the encoder happened to emit', () => {
    expect(cursorShape(encode('{"position":3,"version":1,"id":"a"}'))).toBe(
      cursorShape(encode('{"id":"a","position":3,"version":1}')),
    )
  })

  it('does not collide with the tuple family', () => {
    expect(cursorShape(encode('{"version":1,"values":[{"t":"Text","v":"a"}]}'))).not.toBe(
      cursorShape(encode('{"id":"a","version":1}')),
    )
  })

  // `Cursor::decode` accepts a pre-versioning cursor as v1 for BACKWARD
  // compatibility, but a freshly-minted cursor that stopped stamping its
  // version is a format change and the projection has to be able to say so.
  it('distinguishes an unversioned cursor from v1', () => {
    expect(cursorShape(encode('{"id":"a"}'))).toBe('v?:{id}')
  })
})

describe('cursorShape — the decode is part of the assertion', () => {
  it('is null when the step minted no cursor', () => {
    expect(cursorShape(null)).toBeNull()
  })

  it('refuses the standard base64 alphabet and padding', () => {
    expect(cursorShape('YWJj=')).toBe('<not-base64url>')
    expect(cursorShape('a+b')).toBe('<not-base64url>')
    expect(cursorShape('a/b')).toBe('<not-base64url>')
    // A 1-symbol remainder carries no whole byte; Rust rejects it as
    // InvalidLength where `atob` would silently discard it.
    expect(cursorShape('YWJjY')).toBe('<not-base64url>')
  })

  /**
   * Which half of the projection actually caught the pre-#3893 mock cursor, and
   * why the other half is still needed. Both halves are asserted against the
   * ids the mock REALLY mints — a fixture seed label expands to a 26-character
   * id (`'S3'.padStart(26, '0')`), and the payload length is what decides
   * whether the alphabet check fires at all.
   *
   * The mock's `list_blocks` cursor was `btoa(JSON.stringify({ key, version }))`:
   * a positional tuple in the STANDARD alphabet.
   *
   *   - `list_by_type` mints `{"key":["<26>"],"version":1}` — 50 bytes;
   *   - `list_children` mints `{"key":[<pos>,"<26>"],"version":1}` — 52 bytes
   *     at a single-digit position.
   *
   * Neither length is a multiple of 3, so `btoa` pads both and the ALPHABET
   * check rejects both. For every cursor the fixtures actually replay, the
   * alphabet half is what reddens — which is what makes the shape half easy to
   * mistake for decoration.
   *
   * It is not. The alphabet check is a function of payload LENGTH: a
   * three-digit position makes the same positional payload 54 bytes, a clean
   * multiple of 3, and it then encodes with no `+`, `/` or `=` at all —
   * indistinguishable from base64url. The shape is what separates the two
   * unconditionally: a positional `key` tuple is `{key}` where the backend's
   * `Cursor` is `{id}` or `{id,position}`, at any length.
   */
  it('separates the old positional-tuple cursor from the backend Cursor by SHAPE', () => {
    const id = (label: string) => label.padStart(26, '0')

    // The two payloads the mock really minted: both padded, so the ALPHABET
    // check is what reddened them.
    const oldByType = btoa(JSON.stringify({ key: [id('S3')], version: 1 }))
    expect(cursorShape(oldByType)).toBe('<not-base64url>')
    const oldChildren = btoa(JSON.stringify({ key: [1, id('S2')], version: 1 }))
    expect(cursorShape(oldChildren)).toBe('<not-base64url>')

    // A 54-byte positional payload (three-digit position) is a multiple of 3,
    // so `btoa` emits no padding and no `+` or `/` — the alphabet check passes
    // it, and only the SHAPE tells it apart from the backend's `Cursor`.
    const unpadded = btoa(JSON.stringify({ key: [100, id('S2')], version: 1 }))
    expect(
      /[+/=]/.test(unpadded),
      'this payload must encode identically under both alphabets',
    ).toBe(false)
    expect(cursorShape(unpadded)).toBe('v1:{key}')
    expect(cursorShape(unpadded)).not.toBe('v1:{id,position}')
  })

  it('marks a payload that is not UTF-8 JSON rather than throwing', () => {
    expect(cursorShape(encode('not json at all'))).toBe('<not-json>')
    expect(cursorShape(encode('[1,2]'))).toBe('<not-an-object>')
    // 0xFF is never a valid UTF-8 lead byte — `String::from_utf8` rejects it,
    // so a lenient TextDecoder substituting U+FFFD would accept a payload the
    // backend refuses.
    expect(cursorShape('_w')).toBe('<not-utf8>')
  })
})
