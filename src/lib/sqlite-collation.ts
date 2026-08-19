/**
 * SQLite collation primitives, modelled once.
 *
 * Two orderings show up wherever this app re-establishes a backend `ORDER BY`
 * on the frontend (the picker name caches, the Tauri mock's comparators), and
 * JS's defaults are wrong for BOTH of them:
 *
 *  - `String.prototype.toLowerCase()` folds every cased Unicode character;
 *    SQLite's `NOCASE` folds ONLY ASCII `A`-`Z`. See {@link foldAsciiUppercase}.
 *  - JS `<` / `localeCompare` on strings compare UTF-16 code units (or an ICU
 *    locale collation); SQLite's default `BINARY` collation memcmps UTF-8
 *    BYTES. See {@link compareUtf8Bytes}.
 *
 * Extracted from `use-block-resolve.ts` (#4057 / #4131 / #4138 fixed both there
 * for the picker caches) so the Tauri mock's `compareMetaRows` matches the same
 * backend clause through the same code rather than through a second spelling of
 * it — the divergence #3939 item 1 recorded was exactly that second spelling
 * drifting.
 */

/**
 * SQLite's `NOCASE` collation folds ONLY ASCII `A`-`Z`, unlike
 * `String.toLowerCase()` which folds every cased Unicode character. Mirrors
 * that exactly, so a `COLLATE NOCASE` comparison is matched rather than
 * approximated.
 */
export function foldAsciiUppercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

// #4057 — JS `<` on strings compares UTF-16 CODE UNITS; SQLite's default
// BINARY collation compares UTF-8 BYTES. The two agree everywhere EXCEPT when
// a supplementary-plane character (U+10000+, encoded in UTF-16 as a surrogate
// pair whose leading unit is 0xD800-0xDBFF) is compared against a BMP
// character whose code point falls in 0xE000-0xFFFF: UTF-16 code-unit order
// puts the supplementary character first (0xD800-0xDBFF < 0xE000-0xFFFF),
// while UTF-8 byte order puts it last (its 4-byte encoding starts with
// 0xF0-0xF4, which is greater than the 3-byte encoding's 0xE0-0xEF lead byte
// for that BMP range). Comparing raw UTF-8 bytes sidesteps the surrogate-pair
// encoding entirely and matches BINARY exactly.
//
// `localeCompare` is further off still: it is an ICU collation, so it can
// disagree with byte order on ASCII too (case and digit/letter weighting) and
// on every accented or non-Latin character.
const utf8Encoder = new TextEncoder()

/** Compare two strings as SQLite's `BINARY` collation does — by UTF-8 bytes. */
export function compareUtf8Bytes(a: string, b: string): number {
  const aBytes = utf8Encoder.encode(a)
  const bBytes = utf8Encoder.encode(b)
  const len = Math.min(aBytes.length, bBytes.length)
  for (let i = 0; i < len; i++) {
    const diff = (aBytes[i] as number) - (bBytes[i] as number)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return aBytes.length - bBytes.length
}

/** `COLLATE NOCASE` — {@link foldAsciiUppercase} then a `BINARY` memcmp. */
export function compareNocase(a: string, b: string): number {
  return compareUtf8Bytes(foldAsciiUppercase(a), foldAsciiUppercase(b))
}
