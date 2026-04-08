/**
 * useTheme — custom hook for theme preference management.
 *
 * Reads initial theme from localStorage ('theme-preference') with values:
 * 'light', 'dark', 'auto' (default: 'auto').
 *
 * When 'auto': respects `window.matchMedia('(prefers-color-scheme: dark)')`
 * and listens for changes. Applies/removes `.dark` class on `document.documentElement`.
 *
 * Returns `{ theme, isDark, toggleTheme }` where toggleTheme cycles: auto → dark → light → auto.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'theme-preference'
const CYCLE: ThemePreference[] = ['auto', 'dark', 'light']

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch {
    // localStorage unavailable
  }
  return 'auto'
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

export interface UseThemeReturn {
  theme: ThemePreference
  isDark: boolean
  toggleTheme: () => void
}

export function useTheme(): UseThemeReturn {
  const [theme, setTheme] = useState<ThemePreference>(readPreference)

  // Track OS dark mode for 'auto' — listen for changes via useSyncExternalStore
  const systemDark = useSyncExternalStore(subscribeMediaQuery, getSystemDark, getSystemDarkServer)

  const isDark = useMemo(() => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return systemDark
  }, [theme, systemDark])

  // Apply .dark class on documentElement whenever isDark changes
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDark])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const idx = CYCLE.indexOf(prev)
      const next = CYCLE[(idx + 1) % CYCLE.length] as ThemePreference
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // localStorage unavailable
      }
      return next
    })
  }, [])

  return { theme, isDark, toggleTheme }
}
