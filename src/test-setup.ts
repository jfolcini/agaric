import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import 'vitest-axe/extend-expect'
import * as matchers from 'vitest-axe/matchers'
import './lib/i18n'

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

// pdfjs-dist requires DOMMatrix which jsdom doesn't provide
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    m11 = 1
    m12 = 0
    m13 = 0
    m14 = 0
    m21 = 0
    m22 = 1
    m23 = 0
    m24 = 0
    m31 = 0
    m32 = 0
    m33 = 1
    m34 = 0
    m41 = 0
    m42 = 0
    m43 = 0
    m44 = 1
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0
    is2D = true
    isIdentity = true
    inverse() {
      return new DOMMatrix()
    }
    multiply() {
      return new DOMMatrix()
    }
    translate() {
      return new DOMMatrix()
    }
    scale() {
      return new DOMMatrix()
    }
    rotate() {
      return new DOMMatrix()
    }
    transformPoint() {
      return { x: 0, y: 0, z: 0, w: 1 }
    }
    toFloat32Array() {
      return new Float32Array(16)
    }
    toFloat64Array() {
      return new Float64Array(16)
    }
  } as unknown as typeof globalThis.DOMMatrix
}

// Element.scrollIntoView and Element.getClientRects are not implemented in jsdom.
// Components (EditableBlock, ProseMirror) call these via requestAnimationFrame;
// stub them so unhandled exceptions don't leak into unrelated test suites.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }) as DOMRect
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

// Shared mock for `sonner` — consolidates the `toast` + `Toaster` stubs used
// by ~55 component/hook tests. Per-file `vi.mock('sonner', ...)` overrides
// still work for tests that need custom capture variables.
// See src/__tests__/mocks/sonner.ts for the mock implementation.
vi.mock('sonner', async () => await import('./__tests__/mocks/sonner'))

// Shared mock for `@/components/ui/select` — Radix Select does not work in
// jsdom (no layout engine), so component tests mock it with a native
// `<select>` tree. Consolidates ~17 per-file duplicates of the same mock.
// Per-file overrides still work for tests that need custom behavior (e.g.
// GraphView.test.tsx hardcodes a data-testid).
// See src/__tests__/mocks/ui-select.tsx for the mock implementation.
vi.mock('@/components/ui/select', async () => await import('./__tests__/mocks/ui-select'))

// Stub HTMLCanvasElement.getContext — jsdom does not implement canvas, and
// installing the `canvas` npm package would pull in heavy native cairo
// bindings (~30MB platform-specific binaries) just to silence warnings from
// pdf.js and mermaid in tests that already mock those modules. The tests
// validate component behavior, not pixel output, so a no-op stub is enough.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext
}
