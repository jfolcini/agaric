/**
 * UTF-8 ⇄ unpadded base64url (`A–Z a–z 0–9 - _`, no `=` padding) — the exact
 * alphabet Rust's `base64::engine::general_purpose::URL_SAFE_NO_PAD` produces.
 *
 * Extracted from `inline-query-spec.ts` (#3863) because a SECOND consumer now
 * needs the identical codec: the tauri mock's `run_advanced_query` keyset
 * cursor must byte-match the engine's `QueryCursor::encode`
 * (`agaric-store/src/query/engine.rs:176`), which is
 * `URL_SAFE_NO_PAD.encode(json.as_bytes())` — the UTF-8 bytes of the JSON.
 *
 * Why a leaf module rather than exporting these from `inline-query-spec.ts`:
 * the mock stands in for the Rust backend, and pointing it at a FEATURE
 * module's internals (inline `{{query …}}` block payload encoding) to borrow a
 * generic codec would couple the two for no reason. The mock already depends
 * on shared primitives of exactly this class (`fold-for-search`,
 * `search-query/glob-validate`, `task-states`); this is one more. Both
 * consumers sit in the `lib` tier, so either direction satisfies
 * `check-lib-layering.mjs` — the choice is about coupling, not legality.
 *
 * `btoa`/`atob` alone are NOT a substitute. `btoa` maps each STRING CODE UNIT
 * to one byte: it throws `InvalidCharacterError` above U+00FF (em dash, CJK,
 * emoji) and silently encodes the single Latin-1 byte for U+0080–U+00FF (`é`
 * ⇒ `0xE9` where UTF-8 — and therefore Rust — has `0xC3 0xA9`). Both helpers
 * below go through `TextEncoder`/`TextDecoder`, so every code point round-trips
 * as its UTF-8 bytes and the output matches Rust byte for byte.
 */

/** UTF-8 string → unpadded base64url. */
export function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Unpadded base64url → UTF-8 string (inverse of {@link utf8ToBase64Url}).
 *
 * `fatal` (default `false`) selects what happens to bytes that are NOT valid
 * UTF-8. The default is `TextDecoder`'s own lenient behaviour: substitute
 * U+FFFD and carry on. `fatal: true` makes the decoder THROW a `TypeError`
 * instead, which is what a caller standing in for Rust needs —
 * `String::from_utf8` REJECTS ill-formed bytes, so a decoder that silently
 * replaces them accepts payloads the backend refuses.
 *
 * Opt-in rather than the default because the two other callers
 * (`decodeInlineQueryPayload`, `list_pages_with_metadata`'s cursor decode)
 * are deliberately lenient — each wraps this in a `try`/`catch` that falls
 * back to "no spec" / "start from the top" — and flipping the default would
 * change their behaviour to serve a third caller's needs. #3914 review note 1.
 */
export function base64UrlToUtf8(b64url: string, options?: { fatal?: boolean }): string {
  const padded = b64url.replaceAll('-', '+').replaceAll('_', '/')
  // Re-add the `=` padding base64 needs (length up to the next multiple of 4).
  const fullLength = Math.ceil(padded.length / 4) * 4
  const binary = atob(padded.padEnd(fullLength, '='))
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0)
  return new TextDecoder('utf-8', { fatal: options?.fatal ?? false }).decode(bytes)
}
