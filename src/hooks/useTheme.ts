/**
 * useTheme — custom hook for theme preference management.
 *
 * Reads initial theme from localStorage ('theme-preference'). Supported values:
 *   - 'light', 'dark', 'auto' (classic)
 * 'solarized-light', 'solarized-dark', 'dracula', 'one-dark-pro'
 *
 * Default: 'auto'. When 'auto': respects `window.matchMedia('(prefers-color-scheme: dark)')`
 * and listens for changes.
 *
 * The resolved theme maps to a set of CSS classes on `document.documentElement`:
 *   - light                → (no class)
 *   - dark                 → `.dark`
 *   - solarized-light      → `.theme-solarized-light`
 *   - solarized-dark       → `.dark .theme-solarized-dark`
 *   - dracula              → `.dark .theme-dracula`
 *   - one-dark-pro         → `.dark .theme-one-dark-pro`
 *
 * Adding `.dark` in addition to the theme class ensures any dark-mode-specific
 * styles (e.g. `hljs` syntax highlighting overrides) still apply to the new
 * dark variants without duplication.
 *
 * Returns `{ theme, isDark, toggleTheme, setTheme }`:
 *   - `toggleTheme` cycles through `auto → dark → light` with smart skip
 *     (avoids visual no-ops) for the classic sidebar toggle button.
 *   - `setTheme(value)` sets a specific theme directly (used by the Settings
 *     Select which offers all 7 options).
 *
 * #733 — the preference lives in a MODULE-LEVEL store (localStorage as the
 * source of truth + a shared listener set), consumed via
 * `useSyncExternalStore`. The hook is mounted twice (App.tsx for the
 * sidebar toggle / Toaster, AppearanceTab for the Settings Select); the
 * previous per-instance `useState` meant a Settings choice never reached
 * App's instance, so (a) the sidebar tooltip/icon went stale, (b) the
 * toggle cycled from the OLD value and persisted it over the Settings
 * choice, and (c) an OS `prefers-color-scheme` flip re-applied the stale
 * instance's documentElement classes over the user's explicit choice.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

export type ThemePreference =
  | 'light'
  | 'dark'
  | 'auto'
  | 'solarized-light'
  | 'solarized-dark'
  | 'dracula'
  | 'one-dark-pro'

const STORAGE_KEY = 'theme-preference'

/** All valid themes — used for localStorage validation. */
const ALL_THEMES: readonly ThemePreference[] = [
  'light',
  'dark',
  'auto',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'one-dark-pro',
] as const

/** Theme cycle for the sidebar toggle button (classic light/dark/auto only). */
const CYCLE: ThemePreference[] = ['auto', 'dark', 'light']

/**
 * i18n key for the human-readable display name of each theme. Used by the
 * Sidebar theme-toggle tooltip to surface the current theme.
 *
 * Hyphenated theme ids are mapped to camelCase i18n key segments because the
 * project i18n key convention (enforced in `src/lib/__tests__/i18n.test.ts`)
 * disallows dashes inside segments.
 */
export const THEME_NAME_KEY: Record<ThemePreference, string> = {
  auto: 'sidebar.themeName.auto',
  dark: 'sidebar.themeName.dark',
  light: 'sidebar.themeName.light',
  'solarized-light': 'sidebar.themeName.solarizedLight',
  'solarized-dark': 'sidebar.themeName.solarizedDark',
  dracula: 'sidebar.themeName.dracula',
  'one-dark-pro': 'sidebar.themeName.oneDarkPro',
}

/** Every CSS class the hook may add — cleared before applying the current one. */
const THEME_CLASSES = [
  'dark',
  'theme-solarized-light',
  'theme-solarized-dark',
  'theme-dracula',
  'theme-one-dark-pro',
]

/** Resolved theme is the actual visual theme after resolving 'auto'. */
type ResolvedTheme = Exclude<ThemePreference, 'auto'>

function isValidTheme(v: string | null): v is ThemePreference {
  return v !== null && (ALL_THEMES as readonly string[]).includes(v)
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isValidTheme(stored)) return stored
  } catch {
    // localStorage unavailable
  }
  return 'auto'
}

// ── #733 — module-level preference store ─────────────────────────────
// localStorage is the canonical store; the listener set fans a write out
// to EVERY mounted useTheme instance so the two surfaces (App shell,
// Settings → Appearance) can never desync. `memoryPreference` only takes
// over when localStorage itself is unusable (private-mode quota, etc.) —
// in that degraded mode the preference still propagates across instances
// for the session, it just doesn't survive a relaunch.
const preferenceListeners = new Set<() => void>()
let memoryPreference: ThemePreference = 'auto'
let localStorageBroken = false

function getPreferenceSnapshot(): ThemePreference {
  if (localStorageBroken) return memoryPreference
  return readPreference()
}

function getPreferenceServerSnapshot(): ThemePreference {
  return 'auto'
}

function subscribePreference(callback: () => void): () => void {
  preferenceListeners.add(callback)
  return () => {
    preferenceListeners.delete(callback)
  }
}

/** Write the preference to the shared store and notify every instance. */
function setPreference(next: ThemePreference): void {
  if (getPreferenceSnapshot() === next) return
  memoryPreference = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // localStorage unavailable — degrade to the in-memory store so the
    // theme still changes (and stays consistent across instances) for
    // the rest of the session.
    localStorageBroken = true
  }
  for (const listener of preferenceListeners) listener()
}

/** Subscribe to OS-level prefers-color-scheme changes. */
function subscribeMediaQuery(callback: () => void) {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSystemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function getSystemDarkServer() {
  return false
}

function resolveTheme(theme: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (theme === 'auto') return systemDark ? 'dark' : 'light'
  return theme
}

function isResolvedDark(resolved: ResolvedTheme): boolean {
  return (
    resolved === 'dark' ||
    resolved === 'solarized-dark' ||
    resolved === 'dracula' ||
    resolved === 'one-dark-pro'
  )
}

function applyThemeClasses(resolved: ResolvedTheme) {
  const root = document.documentElement
  root.classList.remove(...THEME_CLASSES)
  switch (resolved) {
    case 'light': {
      // no class — :root defaults apply
      break
    }
    case 'dark': {
      root.classList.add('dark')
      break
    }
    case 'solarized-light': {
      root.classList.add('theme-solarized-light')
      break
    }
    case 'solarized-dark': {
      root.classList.add('dark', 'theme-solarized-dark')
      break
    }
    case 'dracula': {
      root.classList.add('dark', 'theme-dracula')
      break
    }
    case 'one-dark-pro': {
      root.classList.add('dark', 'theme-one-dark-pro')
      break
    }
  }
}

export interface UseThemeReturn {
  theme: ThemePreference
  isDark: boolean
  toggleTheme: () => void
  setTheme: (theme: ThemePreference) => void
}

export function useTheme(): UseThemeReturn {
  // #733 — every instance reads the SAME module-level preference store,
  // so a Settings change reaches the App shell instance synchronously.
  const theme = useSyncExternalStore(
    subscribePreference,
    getPreferenceSnapshot,
    getPreferenceServerSnapshot,
  )

  // Track OS dark mode for 'auto' — listen for changes via useSyncExternalStore
  const systemDark = useSyncExternalStore(subscribeMediaQuery, getSystemDark, getSystemDarkServer)

  const resolved = useMemo(() => resolveTheme(theme, systemDark), [theme, systemDark])
  const isDark = useMemo(() => isResolvedDark(resolved), [resolved])

  // Apply theme classes on documentElement whenever resolved theme changes
  useEffect(() => {
    applyThemeClasses(resolved)
  }, [resolved])

  const setTheme = useCallback((next: ThemePreference) => {
    setPreference(next)
  }, [])

  const toggleTheme = useCallback(() => {
    // Read both inputs LIVE from their stores — never from a render-time
    // closure — so the cycle always starts from the preference the user
    // most recently chose anywhere in the app (#733).
    const prev = getPreferenceSnapshot()
    const sd = getSystemDark()
    const prevDark = isResolvedDark(resolveTheme(prev, sd))
    // Start from prev's position in the classic CYCLE. If prev is outside
    // CYCLE (one of the custom themes), `indexOf` returns -1 which causes
    // `(-1 + 1) % 3 === 0 → 'auto'` — a sensible fallback that re-enters the
    // classic cycle from the beginning.
    const idx = CYCLE.indexOf(prev)
    // Smart skip: advance through the cycle until we find a state
    // that resolves to a different isDark value, avoiding visual no-ops.
    for (let step = 1; step <= CYCLE.length; step++) {
      const candidate = CYCLE[(idx + step) % CYCLE.length] as ThemePreference
      const candidateDark = isResolvedDark(resolveTheme(candidate, sd))
      if (candidateDark !== prevDark) {
        setPreference(candidate)
        return
      }
    }
    // Fallback: advance one step (reached only if every cycle candidate
    // matches prev's isDark, e.g. with 3 states it shouldn't happen).
    setPreference(CYCLE[(idx + 1) % CYCLE.length] as ThemePreference)
  }, [])

  return { theme, isDark, toggleTheme, setTheme }
}

/**
 * Test-only — restore the module-level store's degraded-mode flags so a
 * test that breaks `localStorage` can't leak the in-memory fallback into
 * subsequent tests. The happy path needs no reset: localStorage is the
 * canonical store and tests already clear it between cases.
 */
export function __resetThemeStoreForTests(): void {
  memoryPreference = 'auto'
  localStorageBroken = false
}
