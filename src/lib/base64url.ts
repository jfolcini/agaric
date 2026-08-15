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
 * The unpadded base64url alphabet, plus the length rule
 * `URL_SAFE_NO_PAD.decode` enforces — a remainder of 1 symbol carries no
 * whole byte, so Rust rejects it as `InvalidLength`.
 *
 * Shared by every mock cursor decoder that must match `URL_SAFE_NO_PAD`'s
 * strictness (`run_advanced_query`'s `decodeCursor` / `decodeGroupCursor` in
 * `handlers/search.ts`, `list_blocks`'s `decodeBlocksCursor` in
 * `handlers/blocks.ts`, #3942 review note 5) — extracted here rather than
 * left as `search.ts`-local once a second caller needed the identical check,
 * the same reasoning `utf8ToBase64Url`/`base64UrlToUtf8` were extracted for.
 *
 * Checked ahead of {@link base64UrlToUtf8} rather than relying on `atob` to
 * throw, for two reasons: it separates the engine's FIRST failure mode (bad
 * base64) from its SECOND (invalid UTF-8), which the single combined call
 * cannot, and it does so without sniffing the host's exception type —
 * `atob` throws a `DOMException` and a fatal `TextDecoder` a `TypeError`, but
 * which of those is observable is a runtime detail (jsdom vs Node), the same
 * host-dependence #3914 review note 2 objects to in the message. It is also
 * what stops `atob`'s own leniency from reaching production: `atob` accepts
 * the STANDARD alphabet (`+`, `/`) and tolerates `=` padding, where
 * `URL_SAFE_NO_PAD` rejects both outright — #3942 review note 5 is a
 * cursor decoder that skipped this gate and so accepted a foreign
 * standard-alphabet cursor the backend refuses.
 *
 * Deliberately NOT mirrored: Rust's base64 also rejects non-canonical
 * trailing bits — a final symbol whose leftover bits are not zero, such as
 * `"AB"` (12 bits for one byte, and the spare 4 are `0001`) — which `atob`
 * silently discards instead. That is a strictly narrower acceptance on the
 * engine's side and a cursor with such bytes cannot be minted by any of this
 * module's callers, so the residual divergence is unreachable except by a
 * hand-built cursor whose payload would then have to also be valid UTF-8 and
 * valid JSON to reach a keyset at all (#3942 review note 6a).
 */
export const BASE64URL_NO_PAD = /^[A-Za-z0-9_-]*$/

/** True iff `s` is a well-formed `URL_SAFE_NO_PAD` token by alphabet and
 *  length alone — see {@link BASE64URL_NO_PAD} for what that does and does
 *  not catch. */
export function isBase64UrlNoPad(s: string): boolean {
  return BASE64URL_NO_PAD.test(s) && s.length % 4 !== 1
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
