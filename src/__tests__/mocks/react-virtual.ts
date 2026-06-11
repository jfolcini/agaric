// Shared mock factory for `@tanstack/react-virtual` used by component tests
// that render a virtualized list (search results, agenda/due/done panels,
// history, page browser, emoji picker, …).
//
// Why a mock is needed: jsdom / happy-dom give the scroll container zero
// height, so the real `useVirtualizer` collapses the virtual window to zero
// rows and the rendered list is empty. Tests that assert on row contents
// (`getAllByRole('option')`, keyboard roving, grouping) need every row laid
// out. This factory mirrors the long-duplicated per-file mock (counted in
// #762: copy-pasted across ~14 files) in one place.
//
// Usage (default — render every row, honest total height):
//
//   import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
//   vi.mock('@tanstack/react-virtual', () => mockReactVirtual())
//
// Usage (windowed — only render the first N rows, e.g. EmojiPicker /
// SearchResultGroups overflow tests):
//
//   vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 8 }))
//
// Usage (capture scroll / estimate calls — PageBrowser, SearchResultGroups):
// pass `vi.hoisted` mocks so the factory stays hoist-safe.
//
//   const { scrollToOffset } = vi.hoisted(() => ({ scrollToOffset: vi.fn() }))
//   vi.mock('@tanstack/react-virtual', () =>
//     mockReactVirtual({ scrollToOffset }))
//
// All options are plain values/fns, so the call is self-contained and safe to
// place inside the hoisted `vi.mock` factory.
import { vi } from 'vitest'

interface VirtualItem {
  index: number
  key: number
  start: number
  size: number
  end: number
}

interface VirtualizerOpts {
  count: number
  estimateSize: (index: number) => number
}

export interface MockReactVirtualOptions {
  /**
   * Cap the number of laid-out rows (the rest exist only in `getTotalSize`).
   * Defaults to "render every row". Use for overflow / windowing assertions.
   * Pass a getter (`() => number | null`) when the window size changes
   * between tests — it is read lazily on every `useVirtualizer` call.
   */
  windowSize?: number | null | (() => number | null)
  /**
   * Override `getTotalSize`. Defaults to the summed estimated sizes of ALL
   * rows (honest spacer height). Pass a number for a fixed total.
   */
  totalSize?: number
  /** Spy/handler for `scrollToIndex(index)`. Defaults to a fresh `vi.fn()`. */
  scrollToIndex?: (index: number) => void
  /** Spy/handler for `scrollToOffset(offset)`. Defaults to a fresh `vi.fn()`. */
  scrollToOffset?: (offset: number) => void
  /** Spy/handler for `measureElement`. Defaults to a no-op. */
  measureElement?: (el: Element | null) => void
  /**
   * Called with each `opts.estimateSize` the virtualizer was constructed with.
   * Lets tests capture and invoke the estimator (PageBrowser size assertions).
   */
  onEstimateSize?: (estimateSize: (index: number) => number) => void
}

/**
 * Build the mock module object for `@tanstack/react-virtual`. Returns
 * `{ useVirtualizer }`. See the module docblock for usage from `vi.mock`.
 */
export function mockReactVirtual(options: MockReactVirtualOptions = {}) {
  const {
    windowSize = null,
    totalSize,
    scrollToIndex = vi.fn(),
    scrollToOffset = vi.fn(),
    measureElement = () => {},
    onEstimateSize,
  } = options

  return {
    useVirtualizer: (opts: VirtualizerOpts) => {
      onEstimateSize?.(opts.estimateSize)

      const win = typeof windowSize === 'function' ? windowSize() : windowSize
      const limit = win === null ? opts.count : Math.min(win, opts.count)

      let start = 0
      const items: VirtualItem[] = Array.from({ length: limit }, (_, index) => {
        const size = opts.estimateSize(index)
        const item: VirtualItem = { index, key: index, start, size, end: start + size }
        start += size
        return item
      })

      // Honest spacer height: sum ALL rows' estimated sizes (not just the
      // windowed slice), unless the caller pinned a fixed total.
      let total = totalSize
      if (total === undefined) {
        total = 0
        for (let i = 0; i < opts.count; i++) total += opts.estimateSize(i)
      }

      return {
        getVirtualItems: () => items,
        getTotalSize: () => total,
        scrollToIndex,
        scrollToOffset,
        measureElement,
      }
    },
  }
}
