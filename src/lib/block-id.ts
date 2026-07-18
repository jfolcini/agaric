/**
 * Client-side ULID generation for optimistic block creation (#2849 PR2).
 *
 * The optimistic `createBelow` path needs the new block's id BEFORE the
 * `create_block` IPC resolves, so it can splice the row into the store
 * immediately and keep focus/selection on a stable id (never relocating to a
 * server-minted id after the round-trip). The backend accepts this id verbatim
 * (`create_block(blockId)`) only when it parses as a well-formed ULID via the
 * Rust `ulid` crate, so the generated string MUST be spec-compliant.
 *
 * ULID layout (128 bits): a 48-bit millisecond timestamp followed by 80 bits of
 * randomness, encoded as 26 Crockford base32 chars (10 time + 16 random). This
 * is the exact encoding of the reference `ulid` JS library and is byte-for-byte
 * interoperable with `ulid::Ulid::from_str` — the time/random split lands on a
 * char boundary (80 is a multiple of 5) and the 2 spare high bits are absorbed
 * as leading zeros in the time prefix, so decoding the 26 chars as a single
 * u128 yields `(time << 80) | random`. Randomness comes from
 * `crypto.getRandomValues`, a primitive available on every webview target
 * (WebKitGTK, WebView2, WKWebView, Android) — no Chromium-only dependency, and
 * no npm dependency (a self-contained generator avoids lockfile / shared
 * node_modules churn).
 */

/** Crockford's base32 alphabet (excludes I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Number of symbols in the alphabet (5 bits per char). */
const ENCODING_LEN = 32
/** Time component: 48 bits encoded in 10 base32 chars (top 2 bits zero). */
const TIME_LEN = 10
/** Random component: 80 bits encoded in 16 base32 chars. */
const RANDOM_LEN = 16

/** Encode `now` (ms since epoch) as `TIME_LEN` Crockford base32 chars. */
function encodeTime(now: number): string {
  let out = ''
  let n = now
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = n % ENCODING_LEN
    out = ENCODING[mod] + out
    n = (n - mod) / ENCODING_LEN
  }
  return out
}

/** Encode `RANDOM_LEN` chars of cryptographic randomness (5 bits per char). */
function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    // The low 5 bits of a uniform byte are uniform over 0..31 — a valid,
    // unbiased Crockford symbol index.
    out += ENCODING[b & 31]
  }
  return out
}

/**
 * Generate a fresh, monotonic-ish, spec-compliant ULID (26 uppercase Crockford
 * base32 chars) for a new block. Accepted verbatim by the backend's
 * `create_block(blockId)` path (#2849 PR2).
 */
export function newBlockId(): string {
  return encodeTime(Date.now()) + encodeRandom()
}
