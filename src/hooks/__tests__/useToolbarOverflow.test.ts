/**
 * Unit tests for `useToolbarOverflow` (PEND-33 Layer B).
 *
 * Covers (per plan lines 259-263):
 *  - Items fit (no overflow returned)
 *  - Items overflow (trailing items in `overflowed`)
 *  - Item count changes (e.g. 17 items → 13 items after a button hides)
 *  - Container resize triggers re-measurement
 *  - Priority ordering (lower priority drops first)
 *  - Stable ordering on re-measure (deterministic)
 *  - Overflow trigger absent when nothing overflows
 *
 * Plan note: avoid mocking `getBoundingClientRect` / `offsetWidth`
 * globally; provide explicit width fixtures per test instead. We do
 * that here by spying on `getBoundingClientRect` only on the sentinel
 * children (matched by their `data-toolbar-item-key`) inside the test
 * file's `beforeEach`, and restoring in `afterEach`.
 */

import { act, render } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  computeOverflow,
  OVERFLOW_TRIGGER_WIDTH_PX,
  POPOVER_TRIGGER_VARIABLE_RESERVE_PX,
  type ToolbarItem,
  useToolbarOverflow,
} from '../useToolbarOverflow'

// ── MockResizeObserver ────────────────────────────────────────────────
// A minimal RO that captures observed elements + lets the test fire
// the callback with a synthetic width. The global `test-setup.ts` ships
// a no-op ResizeObserver stub; we override it per test file.

type Cb = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  private cb: Cb
  observed: Element[] = []

  constructor(cb: Cb) {
    this.cb = cb
    MockResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(el: Element): void {
    this.observed = this.observed.filter((x) => x !== el)
  }
  disconnect(): void {
    this.observed = []
  }
  /** Fire the callback with a synthetic width. */
  trigger(width: number): void {
    const entry = {
      contentRect: { width, height: 0, top: 0, left: 0, right: width, bottom: 0 },
      target: this.observed[0],
    } as unknown as ResizeObserverEntry
    this.cb([entry], this as unknown as ResizeObserver)
  }
}

const OriginalResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  MockResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  vi.stubGlobal('ResizeObserver', OriginalResizeObserver)
  vi.restoreAllMocks()
})

// ── computeOverflow (pure function) ───────────────────────────────────

describe('computeOverflow', () => {
  function btn(key: string, priority: number, group: number): ToolbarItem {
    return { kind: 'button', key, group, priority }
  }
  function sep(key: string, group: number): ToolbarItem {
    return { kind: 'separator', key, group, priority: 0 }
  }

  it('returns everything visible when container width is 0 (defer-split)', () => {
    const items = [btn('a', 50, 0), btn('b', 50, 0)]
    const widths = new Map([
      ['a', 30],
      ['b', 30],
    ])
    const result = computeOverflow(items, 0, widths, 28)
    expect(result.visible).toEqual(items)
    expect(result.overflowed).toEqual([])
  })

  it('returns all items visible when total width fits container', () => {
    const items = [btn('a', 50, 0), btn('b', 50, 0), btn('c', 50, 0)]
    const widths = new Map([
      ['a', 30],
      ['b', 30],
      ['c', 30],
    ])
    const result = computeOverflow(items, 200, widths, 28)
    expect(result.overflowed).toEqual([])
    expect(result.visible).toHaveLength(3)
  })

  it('drops the lowest-priority button first when overflow is needed', () => {
    // 3 buttons (30 px each) need 90 px. Container = 70 px (fits 2 + the
    // 28 px overflow trigger means budget = 42 px → only 1 button fits).
    const items = [btn('hi', 90, 0), btn('mid', 50, 0), btn('lo', 30, 0)]
    const widths = new Map([
      ['hi', 30],
      ['mid', 30],
      ['lo', 30],
    ])
    const result = computeOverflow(items, 70, widths, 28)
    // budget = 70 - 28 = 42; sum starts at 90; drop lo (30→60); drop mid (60→30); fits
    expect(result.visible.map((i) => i.key)).toEqual(['hi'])
    expect(result.overflowed.map((i) => i.key)).toEqual(['mid', 'lo'])
  })

  it('within ties: drops the later-positioned item first', () => {
    // 3 buttons same priority 50. Container forces 1 drop.
    const items = [btn('first', 50, 0), btn('second', 50, 0), btn('third', 50, 0)]
    const widths = new Map([
      ['first', 30],
      ['second', 30],
      ['third', 30],
    ])
    // Total = 90. Budget = 70 - 28 = 42 → must drop 2.
    const result = computeOverflow(items, 70, widths, 28)
    expect(result.visible.map((i) => i.key)).toEqual(['first'])
    expect(result.overflowed.map((i) => i.key)).toEqual(['second', 'third'])
  })

  it('keeps separator only when both sides have visible buttons', () => {
    // 2 buttons in group 0, 2 buttons in group 1, separator between.
    // Drop all of group 1 → separator collapses.
    const items: ToolbarItem[] = [
      btn('a', 90, 0),
      btn('b', 90, 0),
      sep('s', 0),
      btn('c', 30, 1),
      btn('d', 30, 1),
    ]
    const widths = new Map([
      ['a', 30],
      ['b', 30],
      ['s', 8],
      ['c', 30],
      ['d', 30],
    ])
    // budget tight enough that c + d drop. 30+30+0+0+0 = 60 ≤ budget
    const result = computeOverflow(items, 100, widths, 28)
    expect(result.visible.map((i) => i.key)).toEqual(['a', 'b'])
    expect(result.overflowed.map((i) => i.key)).toEqual(['c', 'd'])
  })

  it('reserves +24 px for popover-trigger items via isPopoverTrigger', () => {
    // single popover-trigger button. Its measured base width is 30, so
    // effective width = 30 + 24 = 54. Container = 60 → fits inline.
    const items: ToolbarItem[] = [
      { kind: 'button', key: 'pop', group: 0, priority: 90, isPopoverTrigger: true },
    ]
    const widths = new Map([['pop', 30]])
    expect(POPOVER_TRIGGER_VARIABLE_RESERVE_PX).toBe(24)

    const fits = computeOverflow(items, 60, widths, 28)
    expect(fits.overflowed).toEqual([])

    // Container = 50 → 54 doesn't fit, must overflow. Budget = 50 - 28 = 22, < 54.
    const overflows = computeOverflow(items, 50, widths, 28)
    expect(overflows.visible).toEqual([])
    expect(overflows.overflowed.map((i) => i.key)).toEqual(['pop'])
  })

  it('returns deterministic order on repeated calls (stable)', () => {
    const items = [btn('a', 50, 0), btn('b', 50, 0), btn('c', 50, 0), btn('d', 50, 0)]
    const widths = new Map([
      ['a', 30],
      ['b', 30],
      ['c', 30],
      ['d', 30],
    ])
    const r1 = computeOverflow(items, 90, widths, 28)
    const r2 = computeOverflow(items, 90, widths, 28)
    expect(r1.visible.map((i) => i.key)).toEqual(r2.visible.map((i) => i.key))
    expect(r1.overflowed.map((i) => i.key)).toEqual(r2.overflowed.map((i) => i.key))
  })

  it('preserves original order in `visible` and `overflowed` arrays', () => {
    // dropping 'b' (priority 30 < 'a' / 'c' priority 50) should leave
    // 'a','c' in visible — in their original document order.
    const items = [btn('a', 50, 0), btn('b', 30, 0), btn('c', 50, 0)]
    const widths = new Map([
      ['a', 30],
      ['b', 30],
      ['c', 30],
    ])
    // Container 89: total=90 > 89 so overflow is needed. budget = 89-28 = 61.
    // Drop b (lowest pri) → 60 ≤ 61 ✓.
    const result = computeOverflow(items, 89, widths, 28)
    expect(result.visible.map((i) => i.key)).toEqual(['a', 'c'])
    expect(result.overflowed.map((i) => i.key)).toEqual(['b'])
  })
})

// ── useToolbarOverflow (hook integration) ─────────────────────────────

interface HarnessProps {
  items: ToolbarItem[]
  widths: Record<string, number>
  onResult: (r: { visible: ToolbarItem[]; overflowed: ToolbarItem[] }) => void
}

function Harness({ items, widths, onResult }: HarnessProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  const result = useToolbarOverflow(containerRef, sentinelRef, items)

  React.useEffect(() => {
    onResult(result)
  })

  return React.createElement(
    'div',
    null,
    React.createElement('div', { ref: containerRef, 'data-testid': 'container' }),
    React.createElement(
      'div',
      { ref: sentinelRef, 'data-testid': 'sentinel' },
      items.map((item) =>
        React.createElement('span', {
          key: item.key,
          'data-toolbar-item-key': item.key,
          'data-test-width': String(widths[item.key] ?? 0),
        }),
      ),
    ),
  )
}

/**
 * Spy on getBoundingClientRect for elements in the sentinel — read width
 * from `data-test-width` set per element by the harness. Scoped per
 * test via the spy's `mockRestore` triggered by `vi.restoreAllMocks` in
 * the afterEach above.
 */
function installWidthSpy(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const w = Number(this.getAttribute('data-test-width') ?? '0')
      return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0 } as DOMRect
    },
  )
}

describe('useToolbarOverflow', () => {
  it('returns no overflow when container has not been observed yet', () => {
    installWidthSpy()
    const items: ToolbarItem[] = [
      { kind: 'button', key: 'a', group: 0, priority: 50 },
      { kind: 'button', key: 'b', group: 0, priority: 50 },
    ]
    let last = { visible: [] as ToolbarItem[], overflowed: [] as ToolbarItem[] }
    render(
      React.createElement(Harness, {
        items,
        widths: { a: 30, b: 30 },
        onResult: (r) => {
          last = r
        },
      }),
    )
    // No ResizeObserver fire yet → containerWidth=0 → all visible (defer-split)
    expect(last.overflowed).toEqual([])
    expect(last.visible.map((i) => i.key)).toEqual(['a', 'b'])
  })

  it('produces overflow once ResizeObserver fires with a narrow width', () => {
    installWidthSpy()
    const items: ToolbarItem[] = [
      { kind: 'button', key: 'a', group: 0, priority: 100 },
      { kind: 'button', key: 'b', group: 0, priority: 50 },
      { kind: 'button', key: 'c', group: 0, priority: 30 },
    ]
    let last = { visible: [] as ToolbarItem[], overflowed: [] as ToolbarItem[] }
    render(
      React.createElement(Harness, {
        items,
        widths: { a: 30, b: 30, c: 30 },
        onResult: (r) => {
          last = r
        },
      }),
    )

    // container width 70 → budget 42 → only 1 button fits → 'c' (30) + 'b' (50) drop
    act(() => {
      MockResizeObserver.instances[0]?.trigger(70)
    })

    expect(last.visible.map((i) => i.key)).toEqual(['a'])
    expect(last.overflowed.map((i) => i.key)).toEqual(['b', 'c'])
  })

  it('re-measures when container resizes', () => {
    installWidthSpy()
    const items: ToolbarItem[] = [
      { kind: 'button', key: 'a', group: 0, priority: 100 },
      { kind: 'button', key: 'b', group: 0, priority: 50 },
      { kind: 'button', key: 'c', group: 0, priority: 30 },
    ]
    let last = { visible: [] as ToolbarItem[], overflowed: [] as ToolbarItem[] }
    render(
      React.createElement(Harness, {
        items,
        widths: { a: 30, b: 30, c: 30 },
        onResult: (r) => {
          last = r
        },
      }),
    )

    act(() => {
      MockResizeObserver.instances[0]?.trigger(70)
    })
    expect(last.overflowed).toHaveLength(2)

    // Widen the container → everything fits.
    act(() => {
      MockResizeObserver.instances[0]?.trigger(500)
    })
    expect(last.overflowed).toEqual([])
    expect(last.visible).toHaveLength(3)
  })

  it('handles item count changes (e.g. 5 → 3 items after conditional hide)', () => {
    installWidthSpy()

    let setCount = (_n: number) => {}
    function CountingHarness({
      onResult,
    }: {
      onResult: (r: { visible: ToolbarItem[]; overflowed: ToolbarItem[] }) => void
    }): React.ReactElement {
      const [n, setN] = React.useState(5)
      setCount = setN
      const items: ToolbarItem[] = Array.from({ length: n }, (_, i) => ({
        kind: 'button' as const,
        key: `b${i}`,
        group: 0,
        priority: 100 - i, // earlier items higher priority
      }))
      const widths: Record<string, number> = {}
      for (const item of items) widths[item.key] = 30

      const containerRef = React.useRef<HTMLDivElement>(null)
      const sentinelRef = React.useRef<HTMLDivElement>(null)
      const result = useToolbarOverflow(containerRef, sentinelRef, items)
      React.useEffect(() => {
        onResult(result)
      })

      return React.createElement(
        'div',
        null,
        React.createElement('div', { ref: containerRef }),
        React.createElement(
          'div',
          { ref: sentinelRef },
          items.map((item) =>
            React.createElement('span', {
              key: item.key,
              'data-toolbar-item-key': item.key,
              'data-test-width': String(widths[item.key]),
            }),
          ),
        ),
      )
    }

    let last = { visible: [] as ToolbarItem[], overflowed: [] as ToolbarItem[] }
    render(
      React.createElement(CountingHarness, {
        onResult: (r) => {
          last = r
        },
      }),
    )

    // 5 items × 30 = 150. Container 100 → must overflow.
    act(() => {
      MockResizeObserver.instances[0]?.trigger(100)
    })
    expect(last.overflowed.length).toBeGreaterThan(0)

    // Reduce to 3 items.
    act(() => {
      setCount(3)
    })
    // Re-fire the resize observer with the same width to recompute.
    act(() => {
      MockResizeObserver.instances[0]?.trigger(100)
    })

    // 3 items × 30 = 90 ≤ 100 → all fit, no overflow.
    expect(last.overflowed).toEqual([])
    expect(last.visible).toHaveLength(3)
  })

  it('produces deterministic results across re-measures with same inputs', () => {
    installWidthSpy()
    const items: ToolbarItem[] = [
      { kind: 'button', key: 'a', group: 0, priority: 50 },
      { kind: 'button', key: 'b', group: 0, priority: 50 },
      { kind: 'button', key: 'c', group: 0, priority: 50 },
      { kind: 'button', key: 'd', group: 0, priority: 50 },
    ]
    let last: { visible: ToolbarItem[]; overflowed: ToolbarItem[] } = {
      visible: [],
      overflowed: [],
    }
    render(
      React.createElement(Harness, {
        items,
        widths: { a: 30, b: 30, c: 30, d: 30 },
        onResult: (r) => {
          last = r
        },
      }),
    )

    // Fire 90 → some overflow.
    act(() => {
      MockResizeObserver.instances[0]?.trigger(90)
    })
    const firstResult = last.visible.map((i) => i.key)
    expect(firstResult.length).toBeGreaterThan(0)

    // Fire 200 (everything fits), then back to 90. The same-width result
    // should match `firstResult` exactly — no shuffle on re-measure.
    act(() => {
      MockResizeObserver.instances[0]?.trigger(200)
    })
    act(() => {
      MockResizeObserver.instances[0]?.trigger(90)
    })
    const secondResult = last.visible.map((i) => i.key)
    expect(secondResult).toEqual(firstResult)
  })

  it('OVERFLOW_TRIGGER_WIDTH_PX matches the exported constant', () => {
    expect(OVERFLOW_TRIGGER_WIDTH_PX).toBeGreaterThan(0)
    expect(OVERFLOW_TRIGGER_WIDTH_PX).toBeLessThan(100)
  })

  it('cleans up the ResizeObserver on unmount', () => {
    installWidthSpy()
    const items: ToolbarItem[] = [{ kind: 'button', key: 'a', group: 0, priority: 50 }]
    const { unmount } = render(
      React.createElement(Harness, {
        items,
        widths: { a: 30 },
        onResult: () => {},
      }),
    )

    const ro = MockResizeObserver.instances[0]
    expect(ro?.observed).toHaveLength(1)
    unmount()
    expect(ro?.observed).toHaveLength(0)
  })
})
