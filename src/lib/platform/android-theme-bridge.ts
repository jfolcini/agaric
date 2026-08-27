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
 * A FULLY TRANSPARENT colour is `null` too, not black. `rgba(0, 0, 0, 0)` is
 * what `getComputedStyle` returns for the initial `transparent` value, which
 * is what `background-color: var(--background)` computes to whenever
 * `--background` is invalid -- an `oklch()` literal on a WebView too old to
 * parse it, for instance. Dropping alpha there would paint the strip PURE
 * BLACK under every theme including the white one: visibly worse than the
 * `windowBackground` this replaces, and from the reader least able to know
 * that it had failed.
 *
 * Exported for direct unit testing, independent of `getComputedStyle` /
 * DOM availability.
 */
export function parseComputedRgb(value: string): { r: number; g: number; b: number } | null {
  const match =
    /rgba?\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)(?:\s*[,/]\s*(-?[\d.]+%?))?/i.exec(value)
  if (!match) return null
  const [, rStr, gStr, bStr, aStr] = match
  // Alpha 0 means "there is no colour here", which is a different answer
  // from "the colour is black" -- see the docblock.
  if (aStr !== undefined) {
    const alpha = aStr.endsWith('%') ? Number(aStr.slice(0, -1)) / 100 : Number(aStr)
    if (Number.isFinite(alpha) && alpha === 0) return null
  }
  const r = Number(rStr)
  const g = Number(gStr)
  const b = Number(bStr)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)))
  return { r: clamp(r), g: clamp(g), b: clamp(b) }
}

/**
 * Normalises ANY CSS colour string the engine understands to 0-255 channels,
 * by painting one pixel with it and READING THAT PIXEL BACK.
 *
 * The obvious implementation -- assign to `fillStyle`, read the string its
 * getter returns -- does not work for the case this function exists for.
 * Blink returns `#rrggbb` from that getter only for an OPAQUE colour in a
 * LEGACY colour space; anything else falls through to the CSS Color 4
 * serialization, which for `oklch(...)` is the `oklch(...)` literal we could
 * not read in the first place. Every theme in `index.css` writes
 * `--background` in `oklch()`, so on the one platform this module exists for,
 * a string-reading fallback resolves nothing at all.
 *
 * `getImageData` is independent of serialization: whatever the engine painted
 * comes back as sRGB bytes. It also subsumes the "did the engine REJECT our
 * value?" problem that a string reader has to solve with a sentinel -- a
 * rejected `fillStyle` silently keeps the previous value, and starting from a
 * cleared canvas makes that detectable as alpha 0, which is already the
 * answer we want for a genuinely transparent colour.
 *
 * Returns `null` when there is no usable canvas (jsdom without a canvas
 * backend, a hardened WebView), when `getImageData` is missing or throws, or
 * when the painted pixel is fully transparent. Every one of those is "cannot
 * answer", never "the colour is black".
 */
export function resolveViaCanvas(value: string): { r: number; g: number; b: number } | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx || typeof ctx.getImageData !== 'function') return null
    ctx.clearRect(0, 0, 1, 1)
    // A TRANSPARENT sentinel, and it is load-bearing. `fillStyle` defaults to
    // opaque black, and assigning a value the engine cannot parse is a silent
    // no-op that leaves the previous value in place -- so without this,
    // `fillRect` would paint opaque black for every unparseable colour and
    // `getImageData` would report it as a real answer at alpha 255. Seeding a
    // fully transparent colour instead makes a rejection indistinguishable
    // from "nothing was painted", which is exactly what it is.
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const data = ctx.getImageData(0, 0, 1, 1).data
    const r = data[0]
    const g = data[1]
    const b = data[2]
    const a = data[3]
    if (r === undefined || g === undefined || b === undefined || a === undefined) return null
    // Rejected, or genuinely transparent. Same answer either way.
    if (a === 0) return null
    return { r, g, b }
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
