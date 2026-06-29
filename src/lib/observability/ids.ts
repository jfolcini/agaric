/**
 * W3C trace-context id helpers for the frontend tracer (#2110, M3b).
 *
 * The backend join key is the **trace id** (32 lowercase hex chars) and the
 * **span id** (16 lowercase hex chars), exactly as `FrontendSpan` requires and
 * as `src-tauri/src/observability/propagation.rs` parses out of the
 * `traceparent` header. We generate both from `crypto.getRandomValues` — a
 * portable primitive available on every webview target (WebKitGTK, WebView2,
 * WKWeb­View, Android) — so there is no Chromium-only dependency.
 *
 * The `traceparent` builder emits the W3C Trace Context version-0 form
 * `00-<trace-id>-<parent-id>-<flags>`; the backend's `TraceContextPropagator`
 * extracts it at the IPC boundary and re-parents the command span under it.
 */

/** Length of a W3C trace id in bytes (128-bit). */
const TRACE_ID_BYTES = 16
/** Length of a W3C span id in bytes (64-bit). */
const SPAN_ID_BYTES = 8

/** Lowercase-hex encode a byte array (no allocation-heavy intermediate). */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0')
  }
  return out
}

/** Fill `n` bytes of cryptographic randomness. */
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

/**
 * Generate a random W3C trace id (32 lowercase hex chars).
 *
 * The all-zero id is invalid per the spec; the probability of `getRandomValues`
 * returning 16 zero bytes is negligible (2^-128), so we do not special-case it
 * — the backend would reject an all-zero id, never silently mis-join.
 */
export function generateTraceId(): string {
  return toHex(randomBytes(TRACE_ID_BYTES))
}

/** Generate a random W3C span id (16 lowercase hex chars). */
export function generateSpanId(): string {
  return toHex(randomBytes(SPAN_ID_BYTES))
}

/** A trace id is valid when it is 32 lowercase hex chars and not all-zero. */
export function isValidTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/.test(traceId) && traceId !== '0'.repeat(32)
}

/** A span id is valid when it is 16 lowercase hex chars and not all-zero. */
export function isValidSpanId(spanId: string): boolean {
  return /^[0-9a-f]{16}$/.test(spanId) && spanId !== '0'.repeat(16)
}
