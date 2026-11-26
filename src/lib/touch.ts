/**
 * Whether the app lays itself out for touch: the platform decides (#7040 M7).
 *
 * - The Tauri app on desktop (Linux, Windows, macOS) is never touch. WebKitGTK
 *   reports `(pointer: coarse)` for a plain mouse on some machines (#1236), so
 *   the media query cannot be trusted there.
 * - The Tauri app on Android is always touch.
 * - A plain browser (`npm run dev`, the Playwright lanes) reads the device: a
 *   coarse pointer with touch hardware (`maxTouchPoints > 0`), which is what
 *   Playwright's phone emulation and vitest's `matchMedia` mocks report.
 *
 * `window.isTauri` tells the Tauri app from a browser: the Tauri runtime defines
 * it in an initialization script before any page script runs, on every
 * platform, and `@tauri-apps/api/mocks` — the browser mock and the bridge —
 * never does (they define `__TAURI_INTERNALS__`, so that one cannot). It is
 * what `isTauri()` in `@tauri-apps/api/core` reads; read here directly, since
 * tests mock that module.
 *
 * CSS reads the same answer through `<html data-touch>` and the `coarse`
 * variant (`src/index.css`).
 */

import { isAndroid } from '@/lib/platform'

export const COARSE_POINTER_QUERY = '(pointer: coarse)'

export function detectTouch(): boolean {
  if (typeof window === 'undefined') return false
  if (window.isTauri === true) return isAndroid()
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia(COARSE_POINTER_QUERY).matches && navigator.maxTouchPoints > 0
}

/**
 * Writes `detectTouch()` onto `<html data-touch>`, and again whenever the
 * pointer changes. Call once, before the first render.
 */
export function syncTouchAttribute(): void {
  const write = () => document.documentElement.toggleAttribute('data-touch', detectTouch())
  write()
  window.matchMedia(COARSE_POINTER_QUERY).addEventListener('change', write)
}
