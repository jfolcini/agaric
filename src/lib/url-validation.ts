/**
 * URL validation helpers for user-entered links (PEND-23 L2).
 *
 * Centralises the blocked-scheme denylist and the `normalizeUrl` /
 * `isAllowedUrl` pair previously inlined in `LinkEditPopover.tsx`.
 *
 * Security rationale: a markdown link editor is a routine XSS / phishing
 * vector. Schemes like `javascript:`, `vbscript:`, and `data:` execute
 * script in the renderer; `file:`, `blob:`, and `about:` open the host
 * filesystem or surface native pages. The denylist below mirrors the
 * schemes that browser sanitisers and CodeQL's
 * `js/incomplete-url-scheme-check` query care about. Matching is
 * case-insensitive so the obvious obfuscations (`JavaScript:`, `FILE:`)
 * are caught too.
 *
 * Pure module — no React, no UI deps.
 */

/**
 * Schemes a user-entered link is never allowed to carry.
 */
const BLOCKED_URL_SCHEMES: readonly string[] = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'about:',
]

/**
 * Whether `url` is free of any blocked scheme prefix. Operates on the
 * raw string (case-insensitive, whitespace-trimmed); does not validate
 * URL syntax beyond the scheme check.
 */
export function isAllowedUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return !BLOCKED_URL_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

/**
 * Normalise a user-entered URL: trim whitespace and prepend `https://`
 * when no protocol scheme is present.
 *
 * Recognises both `scheme://` protocols (http, ftp, …) and schemeless
 * protocols like `mailto:` and `tel:`. Returns `null` for empty input
 * or any URL using a scheme in the blocked denylist, so callers can
 * treat "no value" and "rejected value" identically.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!isAllowedUrl(trimmed)) return null
  // scheme://…  (http://, https://, ftp://, etc.)
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed
  // mailto: and tel: — no authority component
  if (/^(mailto|tel):/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
