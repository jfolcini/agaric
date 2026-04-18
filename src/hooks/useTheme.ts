/**
 * useTheme — custom hook for theme preference management.
 *
 * Reads initial theme from localStorage ('theme-preference'). Supported values:
 *   - 'light', 'dark', 'auto' (classic)
 *   - 'solarized-light', 'solarized-dark', 'dracula', 'one-dark-pro' (UX-203)
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
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

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

function persist(theme: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // localStorage unavailable
  }
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
    case 'light':
      // no class — :root defaults apply
      break
    case 'dark':
      root.classList.add('dark')
      break
    case 'solarized-light':
      root.classList.add('theme-solarized-light')
      break
    case 'solarized-dark':
      root.classList.add('dark', 'theme-solarized-dark')
      break
    case 'dracula':
      root.classList.add('dark', 'theme-dracula')
      break
    case 'one-dark-pro':
      root.classList.add('dark', 'theme-one-dark-pro')
      break
  }
}

export interface UseThemeReturn {
  theme: ThemePreference
  isDark: boolean
  toggleTheme: () => void
  setTheme: (theme: ThemePreference) => void
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<ThemePreference>(readPreference)

  // Track OS dark mode for 'auto' — listen for changes via useSyncExternalStore
  const systemDark = useSyncExternalStore(subscribeMediaQuery, getSystemDark, getSystemDarkServer)

  // Keep a ref so toggleTheme can read the latest value without a dependency
  const systemDarkRef = useRef(systemDark)
  systemDarkRef.current = systemDark

  const resolved = useMemo(() => resolveTheme(theme, systemDark), [theme, systemDark])
  const isDark = useMemo(() => isResolvedDark(resolved), [resolved])

  // Apply theme classes on documentElement whenever resolved theme changes
  useEffect(() => {
    applyThemeClasses(resolved)
  }, [resolved])

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState((prev) => {
      if (prev === next) return prev
      persist(next)
      return next
    })
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const sd = systemDarkRef.current
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
          persist(candidate)
          return candidate
        }
      }
      // Fallback: advance one step (reached only if every cycle candidate
      // matches prev's isDark, e.g. with 3 states it shouldn't happen).
      const next = CYCLE[(idx + 1) % CYCLE.length] as ThemePreference
      persist(next)
      return next
    })
  }, [])

  return { theme, isDark, toggleTheme, setTheme }
}
