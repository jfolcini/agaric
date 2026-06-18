/**
 * External-image load policy + per-domain allowlist (#1492).
 *
 * Follow-up to the inline image node (#1434). The Tauri CSP `img-src` is
 * widened to permit `https:`, which moves the privacy guarantee from
 * CSP-enforced to APP-ENFORCED: a node/static view must withhold the real
 * `src` from the DOM until policy/allowlist permits it (no `<img src>` = no
 * network request). This module holds the pure decision logic and the
 * persisted-key constants; the React glue lives in `useExternalImagePolicy`.
 *
 * Three-state policy (privacy-first default `click`):
 *   - `always` — external images auto-load.
 *   - `click`  — external images show a placeholder + a Load button; clicking
 *     fetches AND remembers the host (added to the allowlist) so future images
 *     from that host auto-load.
 *   - `never`  — external images always show a muted placeholder, no affordance.
 *
 * Only external `http(s)` hosts are gated. Same-origin / `data:` / `blob:` /
 * `asset:` / relative (local-attachment) srcs are never a privacy concern and
 * always load.
 */

export const EXTERNAL_IMAGE_POLICIES = ['always', 'click', 'never'] as const

export type ExternalImagePolicy = (typeof EXTERNAL_IMAGE_POLICIES)[number]

/** Privacy-first default: don't fetch external images until the user opts in. */
export const DEFAULT_EXTERNAL_IMAGE_POLICY: ExternalImagePolicy = 'click'

/** localStorage key for the three-state policy. */
export const EXTERNAL_IMAGE_POLICY_KEY = 'external-image-policy'
/** localStorage key for the per-host allowlist (JSON array of hosts). */
export const EXTERNAL_IMAGE_ALLOWLIST_KEY = 'external-image-allowlist'

export function isExternalImagePolicy(v: string | null): v is ExternalImagePolicy {
  return v !== null && (EXTERNAL_IMAGE_POLICIES as readonly string[]).includes(v)
}

/**
 * Resolve a src to its EXTERNAL host, or `null` if the src is not an external
 * `http(s)` URL (relative, `data:`, `blob:`, `asset:`, same-origin) or is
 * malformed.
 *
 * The host is normalized for exact-equality matching against allowlist entries:
 *   - lowercased (`URL.host` is already lowercased for the authority, but we are
 *     explicit and defensive),
 *   - the port component is left as `URL.host` returns it, which already STRIPS
 *     the protocol-default port (`:443` for https, `:80` for http) — so
 *     `https://example.com` and `https://example.com:443` normalize identically.
 *
 * Same-origin `http(s)` srcs (the page's own origin) are treated as local and
 * return `null` — they carry no cross-origin privacy concern. In the Tauri
 * webview the page origin is `tauri://` / `http://tauri.localhost`, so genuine
 * external hosts never collide with it.
 *
 * Returns `null` (never throws) on a malformed URL so callers can treat it as
 * "not loadable" and render the placeholder.
 */
export function externalImageHost(src: string): string | null {
  // Fast reject: only http/https schemes are external. Anything else
  // (relative path, `data:`, `blob:`, `asset:`, `tauri:`, …) is local.
  if (!/^https?:\/\//i.test(src)) return null

  let url: URL
  try {
    url = new URL(src)
  } catch {
    // Malformed URL — treat as not-loadable (caller renders placeholder).
    return null
  }

  // Same-origin http(s) is the app's own origin (e.g. the dev server or the
  // Tauri webview host) — not a cross-origin privacy concern, so treat as local.
  try {
    if (typeof window !== 'undefined' && url.origin === window.location.origin) {
      return null
    }
  } catch {
    // No DOM (SSR / non-browser test) — fall through; there is no same-origin
    // to compare against, so the host is genuinely external.
  }

  // `URL.host` includes a non-default port and strips the default port. Lowercase
  // defensively so matching is case-insensitive on the host.
  return url.host.toLowerCase()
}

/**
 * Decide whether to actually load an image given the current policy + allowlist.
 *
 * Rules:
 *   - Non-external src (relative / `data:` / `blob:` / `asset:` / same-origin)
 *     → ALWAYS load (`true`). These are never a privacy concern.
 *   - Malformed URL → NOT loaded (`false`); render the placeholder. Never throws.
 *   - `policy === 'always'` → load.
 *   - `policy === 'never'`  → never load.
 *   - `policy === 'click'`  → load iff the (exact, normalized) host is in the
 *     allowlist.
 *
 * Host matching is EXACT EQUALITY against `externalImageHost(src)` — never a
 * substring / `endsWith` test — so an allowlisted `example.com` does NOT
 * authorize `evil-example.com` or `example.com.evil.com`.
 */
export function shouldLoadExternalImage(
  src: string,
  policy: ExternalImagePolicy,
  allowlist: ReadonlySet<string>,
): boolean {
  // Not an external http(s) host → local/data/asset/same-origin OR malformed.
  // We must distinguish the two: a non-http scheme is local (load), but a
  // malformed http(s) URL is not loadable.
  if (!/^https?:\/\//i.test(src)) {
    // Local scheme (relative / data: / blob: / asset: / tauri:) — always load.
    return true
  }

  const host = externalImageHost(src)
  // host === null here means a malformed http(s) URL OR same-origin. Same-origin
  // returns null and should load; a malformed URL should NOT. Re-derive: try to
  // parse — if it parses, it was same-origin (load); if not, malformed (block).
  if (host === null) {
    try {
      new URL(src)
      // Parsed but no external host → same-origin → load.
      return true
    } catch {
      // Malformed → not loadable.
      return false
    }
  }

  if (policy === 'always') return true
  if (policy === 'never') return false
  // policy === 'click' — load only if this exact host was previously allowed.
  return allowlist.has(host)
}
