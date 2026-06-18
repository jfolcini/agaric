import { cleanup, configure } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import 'vitest-axe/extend-expect'
import * as matchers from 'vitest-axe/matchers'

import './lib/i18n'
import { setLogLevel } from './lib/logger'

expect.extend(matchers)

// Quiet the app logger in tests. It defaults to `debug` under
// `import.meta.env.DEV` (which vitest sets), so every `logger.debug`/`info`
// call leaked structured output into the test console — ~900 lines per run,
// drowning real failures. Pin it to `warn`: this removes the debug/info spam
// while preserving `warn`/`error`, which several suites legitimately assert on
// (e.g. markdown-serializer's "emits logger.warn on unknown node"). Tests that
// exercise debug/info logging (logger.test.ts) set their own level per-test,
// and module state is isolated per test file, so this default does not leak.
setLogLevel('warn')

// a11y regression guard (#1505): fail any test that renders a Radix
// dialog/sheet/alert-dialog surface without an accessible description. Radix
// logs `Warning: Missing \`Description\` or \`aria-describedby={undefined}\` for
// {…}` via `console.warn` (fired from a mount-time effect, so it has already
// run by the time `afterEach` checks). This regressed to 95 warnings before
// #1505; surfacing it as a test failure keeps it at zero. The wrapper forwards
// to the original `console.warn` so the message stays visible, and any test
// that installs its own `console.warn` spy transparently bypasses it.
const RADIX_MISSING_DESCRIPTION = /Missing `Description` or `aria-describedby=/
const capturedDialogA11yWarnings: string[] = []
const originalConsoleWarn = console.warn.bind(console)
console.warn = (...args: unknown[]): void => {
  const message = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
  if (RADIX_MISSING_DESCRIPTION.test(message)) capturedDialogA11yWarnings.push(message)
  originalConsoleWarn(...args)
}
afterEach(() => {
  if (capturedDialogA11yWarnings.length > 0) {
    const messages = [...new Set(capturedDialogA11yWarnings)].join('\n')
    capturedDialogA11yWarnings.length = 0
    throw new Error(
      `Radix dialog surface rendered without an accessible Description (#1505):\n${messages}\n` +
        'Add a <Description>/<SheetDescription>/<AlertDialogDescription> (sr-only is fine), ' +
        'or pass aria-describedby={undefined} when a description is genuinely N/A.',
    )
  }
})

// The a11y convention across the suite runs `axe(container)` inside a
// `waitFor(async …)` block. `axe` is CPU-heavy, and the pre-push gate
// (`scripts/verify-ci-equivalent.sh`, Phase 2a) runs vitest *concurrently*
// with `cargo nextest`, which saturates every core. Under that starvation a
// single `axe` pass can exceed Testing Library's default 1000ms `waitFor`
// timeout, so the audit times out before completing even once — a pure
// scheduling flake, not a real violation. Raise the async-util timeout to
// give those passes head-room. It only affects how long a *failing* wait
// retries; a passing `waitFor` still resolves as soon as its callback does,
// so the green path is no slower.
configure({ asyncUtilTimeout: 8000 })

// RTL auto-cleanup relies on a global `afterEach`, which isn't available
// without vitest globals. Register it explicitly.
afterEach(() => {
  cleanup()
})

// Defensive cleanup for `window.visualViewport`. jsdom does not provide this
// API (it stays `undefined`), but several positioning tests redefine it as a
// plain `{ height, width }` object — without an `addEventListener` method —
// and were not restoring it. Floating-UI's `autoUpdate` (used internally by
// every Radix Popover/Tooltip via `@radix-ui/react-popper`) calls
// `getOverflowAncestors(...)` which concatenates `win.visualViewport` into
// the ancestor list and then iterates with `.addEventListener('scroll', …)`.
// Once a test left a polluted mock behind, every subsequent Tooltip mount in
// the same worker process threw `TypeError: ancestor.addEventListener is not
// a function` from a `useLayoutEffect`, which interrupted the user-event
// click sequence and caused intermittent JournalPage / SearchPanel flakes
// under full-suite load. Restoring the property after every test prevents
// this whole class of cross-test pollution.
afterEach(() => {
  if ('visualViewport' in window) {
    try {
      // Reset to the jsdom default (the property does not exist by default,
      // so deleting is the correct restoration).
      delete (window as { visualViewport?: unknown }).visualViewport
    } catch {
      // If the property was defined as non-configurable by a test, fall back
      // to overwriting it with `undefined` so floating-ui's `win.visualViewport
      // || []` short-circuits to an empty array.
      try {
        Object.defineProperty(window, 'visualViewport', {
          value: undefined,
          writable: true,
          configurable: true,
        })
      } catch {
        // Best-effort — if we can't restore, the next test will at least see
        // a deterministic value rather than a leaked mock.
      }
    }
  }
})

// jsdom stubs — APIs missing from jsdom that Radix UI and shadcn/ui components need.
// Constructors take and ignore the same callback their real counterparts do, so
// CodeQL doesn't flag production callers as passing superfluous arguments
// (`js/superfluous-trailing-arguments` would fire on `new ResizeObserver(cb)`
// when the mock's constructor declared zero parameters).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
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
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
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
//
// PEND-06: a minimal `Channel<T>` stub is exported alongside `invoke` because
// `src/lib/tauri.ts::startSync` constructs a `new Channel(...)` at module
// load time. Without a stub, every test that imports `tauri.ts` trips
// vitest's "no Channel export on mock" guard at import time. The stub
// supports the `onmessage` setter and the `(payload) => void` callable shape
// used by `tauri-specta`'s generated bindings; tests that need to assert on
// channel deliveries can construct one and call `channel.onmessage(payload)`
// directly.
class MockChannel<T> {
  onmessage?: (msg: T) => void
  send(msg: T): void {
    if (this.onmessage) this.onmessage(msg)
  }
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: MockChannel,
  // #716: `useAndroidBackButton` imports `addPluginListener` (Android
  // back-button plugin event). The hook never calls it under tests (the
  // Android + `__TAURI_INTERNALS__` guards bail first), but the named
  // export must exist on the shared mock or vitest's missing-export
  // guard trips at import time for every test that renders App.
  addPluginListener: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
}))

// Shared mock for `@tauri-apps/plugin-clipboard-manager` — `src/lib/clipboard.ts`
// dynamically imports this; without a global mock, jsdom-running tests would
// load the real plugin and try to talk IPC. Tests that need to assert on
// clipboard interactions either mock `@/lib/clipboard` directly per-file or
// override `vi.mocked(writeText)` from this module.
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

// Shared mock for `sonner` — consolidates the `toast` + `Toaster` stubs used
// by ~55 component/hook tests. Per-file `vi.mock('sonner', ...)` overrides
// still work for tests that need custom capture variables.
// See src/__tests__/mocks/sonner.ts for the mock implementation.
vi.mock('sonner', async () => await import('./__tests__/mocks/sonner'))

// Shared tooltip provider for tests (#1094). Production mounts ONE app-level
// `<TooltipProvider>` in `src/main.tsx`; the per-surface and IconButton-embedded
// providers were removed. Component tests, however, render individual surfaces
// (and the IconButton primitive) in isolation via bare `render(...)`, so they no
// longer have a provider ancestor — Radix's `Tooltip` throws
// "`Tooltip` must be used within `TooltipProvider`" without one.
//
// Rather than edit ~100 test files (or re-add providers to production
// components), supply the provider once here at the shared test-render layer:
// wrap the real `Tooltip` so every test tree gets a `TooltipProvider` ancestor.
// Everything else (Tooltip/Trigger/Content/Provider) stays the real
// implementation via `importActual`, and a `delayDuration` on an inner
// `<Tooltip>` still overrides the wrapper (Radix Tooltip.Root reads its own
// delay first), so override-preservation tests remain meaningful.
vi.mock('@/components/ui/tooltip', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui/tooltip')>('@/components/ui/tooltip')
  const { createElement } = await import('react')
  const ActualTooltip = actual.Tooltip
  const TooltipWithProvider = (props: React.ComponentProps<typeof actual.Tooltip>) =>
    // `children` is passed as the third `createElement` arg (not a prop) so the
    // `react/no-children-prop` lint stays happy; the prop-object cast satisfies
    // `TooltipProviderProps` (which types `children` as required) under
    // exactOptionalPropertyTypes.
    createElement(
      actual.TooltipProvider,
      { delayDuration: 0 } as React.ComponentProps<typeof actual.TooltipProvider>,
      createElement(ActualTooltip, props),
    )
  TooltipWithProvider.displayName = actual.Tooltip.displayName
  return { ...actual, Tooltip: TooltipWithProvider }
})

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
