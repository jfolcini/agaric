import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import 'vitest-axe/extend-expect'
import * as matchers from 'vitest-axe/matchers'

expect.extend(matchers)

// RTL auto-cleanup relies on a global `afterEach`, which isn't available
// without vitest globals. Register it explicitly.
afterEach(() => {
  cleanup()
})

// jsdom stubs — APIs missing from jsdom that Radix UI and shadcn/ui components need.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null
    readonly rootMargin = '0px'
    readonly thresholds: readonly number[] = [0]
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  } as unknown as typeof globalThis.IntersectionObserver
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// Shared mock for @tauri-apps/api/core — all component & store tests need this.
// Individual tests can override via vi.mocked(invoke).mockResolvedValueOnce(...)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))
