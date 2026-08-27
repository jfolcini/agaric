/**
 * Web -> native theme-background bridge for Android (#4433).
 *
 * ## What this fixes
 *
 * `MainActivity.kt` pads the webview's parent (the activity's content frame)
 * by the system-bar insets (#4426), so the strip behind the status and
 * navigation bars is no longer painted by the webview — it falls back to
 * whatever fills that content frame natively. Before this file existed that
 * was the Android theme's DayNight `windowBackground`, resolved once at
 * activity creation and never revisited, so the strip could neither match any
 * of `useTheme.ts`'s seven app themes nor track a live OS light/dark switch
 * (the `<activity>` declares `configChanges="…|uiMode"`, so `uiMode` changes
 * never even recreate the activity).
 *
 * ## The mechanism
 *
 * `MainActivity.onWebViewCreate` registers a `@JavascriptInterface`-annotated
 * object (`AgaricThemeBridge`) on the webview via `addJavascriptInterface`.
 * That is the SAME primitive Tauri's own IPC already uses on Android — wry's
 * `Ipc` class binds its `postMessage` method to the webview the identical
 * way — so this bridge inherits none of the ordering bug that sank the
 * #4301 fix: that bug was a NATIVE -> WEB push (`evaluateJavascript` racing
 * `loadUrl`, landing on a document that hadn't loaded yet). This is a
 * WEB -> NATIVE call, made only once the page has already loaded and React
 * has mounted, through an interface object bound to the webview INSTANCE
 * (not to any one document) that therefore survives navigation.
 *
 * [`pushThemeBackgroundToNative`] is called from `useTheme.ts` every time the
 * resolved theme changes — including a live OS light/dark switch while the
 * preference is `'auto'` — so native is repainted on every change, not only
 * once at activity creation.
 *
 * ## Colour resolution
 *
 * The seven themes are a CSS construct (`--background` in `index.css`,
 * written in `oklch()`), not a value this module duplicates into a second
 * table that could drift from it. Instead [`pushThemeBackgroundToNative`]
 * reads `getComputedStyle(document.body).backgroundColor` AFTER the theme
 * classes are applied to `documentElement` (`body` is `@apply bg-background`
 * in `index.css`) — the browser's own CSS engine resolves whatever colour
 * space `--background` is written in down to a serialised colour string.
 *
 * That string is NOT always `rgb(...)`. CSS Color 4 says a colour specified
 * with a modern colour function serialises as that function, and Chromium
 * follows it: `--background` is written in `oklch()` throughout `index.css`,
 * so `getComputedStyle` returns `oklch(...)` verbatim on a current WebView.
 * Only colours specified in a legacy format come back as `rgb()`. So the
 * fast-path regex cannot be the only reader -- on the exact platform this
 * module exists for, it is the one least likely to match.
 *
 * [`resolveToRgb`] therefore falls back to letting the browser's own canvas
 * do the conversion, which handles every colour syntax the engine supports
 * without this module owning any colour-space maths. If BOTH fail the push
 * is skipped LOUDLY (`logger.warn`), because the alternative -- returning
 * silently -- is a fix that does nothing on device and says nothing about
 * why, which is indistinguishable from the bug it was meant to fix.
 */

import { logger } from '@/lib/logger'

export interface AndroidThemeBridge {
  /** `r`/`g`/`b` are 0-255 integer channels; `isDark` mirrors `useTheme.ts`'s `isDark`. */
  applyBackground: (r: number, g: number, b: number, isDark: boolean) => void
}

declare global {
  interface Window {
    /** Present only inside the Android wry webview; see module doc. */
    AgaricThemeBridge?: AndroidThemeBridge
  }
}

/**
 * Parses a CSS computed-colour string (`rgb(r, g, b)` / `rgba(r, g, b, a)`,
 * legacy comma-separated or modern space-separated) into 0-255 integer
 * channels, rounding and clamping each. Returns `null` for anything the
 * regex doesn't recognise (e.g. an unresolved `oklch(...)` literal, or an
 * empty string from a DOM with no stylesheet loaded) — the caller treats
 * `null` as "nothing to push", never as a reason to guess.
 *
 * Exported for direct unit testing, independent of `getComputedStyle` /
 * DOM availability.
 */
export function parseComputedRgb(value: string): { r: number; g: number; b: number } | null {
  const match = /rgba?\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/i.exec(value)
  if (!match) return null
  const [, rStr, gStr, bStr] = match
  const r = Number(rStr)
  const g = Number(gStr)
  const b = Number(bStr)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)))
  return { r: clamp(r), g: clamp(g), b: clamp(b) }
}

/**
 * Normalises ANY CSS colour string the engine understands to 0-255 channels,
 * by assigning it to a canvas `fillStyle` and reading back the value the
 * engine normalises it to (`#rrggbb` / `rgba(...)`).
 *
 * This exists because the computed value of an `oklch()` colour serialises as
 * `oklch(...)`, not `rgb(...)` -- see the module doc. Rather than implement
 * OKLCH->sRGB here (a conversion with a gamut-mapping step that would then
 * need its own tests and would drift from whatever the engine actually
 * paints), this asks the same engine that paints the page to do it.
 *
 * Returns `null` when there is no usable canvas (jsdom without a canvas
 * backend, a hardened WebView) or the engine rejects the string -- both are
 * "cannot answer", never "the colour is black".
 */
export function resolveViaCanvas(value: string): { r: number; g: number; b: number } | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    // A known-good sentinel first: if the engine REJECTS our value it silently
    // keeps the previous fillStyle, so without this an unparseable colour
    // would read back as whatever was there before and be pushed as real.
    ctx.fillStyle = '#000000'
    ctx.fillStyle = value
    const normalised = ctx.fillStyle
    if (typeof normalised !== 'string') return null
    // Rejected: fillStyle never moved off the sentinel. Only treat that as a
    // real answer when the caller actually asked for black.
    if (
      normalised === '#000000' &&
      !/^(#000000|#000|black|rgba?\(\s*0\s*[,\s]\s*0\s*[,\s]\s*0)/i.test(value.trim())
    ) {
      return null
    }
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalised)
    if (hex) {
      const [, rHex, gHex, bHex] = hex
      if (rHex === undefined || gHex === undefined || bHex === undefined) return null
      return {
        r: Number.parseInt(rHex, 16),
        g: Number.parseInt(gHex, 16),
        b: Number.parseInt(bHex, 16),
      }
    }
    return parseComputedRgb(normalised)
  } catch {
    return null
  }
}

/**
 * The full resolution chain: the cheap regex for legacy `rgb()`, then the
 * canvas for everything else (`oklch()`, `color()`, `lab()`, named colours).
 */
export function resolveToRgb(value: string): { r: number; g: number; b: number } | null {
  return parseComputedRgb(value) ?? resolveViaCanvas(value)
}

/**
 * Reads the app's currently-resolved background colour and pushes it to
 * native, if the Android bridge is present.
 *
 * A no-op everywhere else (desktop, iOS, tests without the bridge) —
 * presence of `window.AgaricThemeBridge` IS the platform gate here, rather
 * than a user-agent sniff, because that is the exact capability this
 * function needs, and it degrades correctly in a test DOM with no
 * `index.css` loaded (no bridge => nothing to gate on in the first place).
 *
 * Wrapped in try/catch: a `@JavascriptInterface` call is a cross-VM
 * (V8 <-> ART) reflection call on Android and can throw for reasons outside
 * this app's control (WebView update mid-session, restricted work profile).
 * A cosmetic paint must never take the app down.
 */
export function pushThemeBackgroundToNative(isDark: boolean): void {
  const bridge = typeof window === 'undefined' ? undefined : window.AgaricThemeBridge
  if (!bridge) return
  const computed = getComputedStyle(document.body).backgroundColor
  const rgb = resolveToRgb(computed)
  if (!rgb) {
    // Loud on purpose. A silent return here is a fix that does nothing on
    // device and reports the same thing as a fix that worked.
    logger.warn('android-theme-bridge', 'Could not resolve the theme background colour', {
      computed,
    })
    return
  }
  try {
    bridge.applyBackground(rgb.r, rgb.g, rgb.b, isDark)
  } catch {
    // See module doc — a native bridge failure is not this call's problem.
  }
}
