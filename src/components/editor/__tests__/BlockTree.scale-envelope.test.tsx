/**
 * #2467 — Measure phase: the block-tree scale envelope.
 *
 * `useBlockMountLimit` (`src/components/block-tree/use-block-mount-limit.ts`) shipped a
 * provisional `INITIAL_MOUNT_LIMIT = 500` mount ceiling as a mitigation, but
 * that number was chosen without any browser-measured mount cost backing
 * it — see `docs/architecture/editor-and-content.md` § "Mount envelope
 * (#2467)". This file is the bench fixture that Measure phase calls for: at
 * 1,000 / 5,000 / 10,000 blocks on a single (flat) page, it records four
 * numbers production actually pays on a large page:
 *
 *  1. `buildFlatTree` time — turning the store's flat `BlockRow[]` into the
 *     depth-annotated render list (`src/lib/tree-utils.ts`).
 *  2. Splice cost — the store-array copy + `Array.prototype.splice` insert
 *     every mutating reducer performs (mirrors `createBelow` in
 *     `src/stores/page-blocks-reducers.ts`: `const newBlocks = [...cur];
 *     newBlocks.splice(insertIdx, 0, newBlock)`).
 *  3. Initial mount time — mounting the full row list through
 *     `BlockListRenderer`, i.e. real `SortableBlockWrapper` fibers (the
 *     thing `useViewportObserver`'s placeholder pattern does NOT shrink —
 *     see § "Viewport rendering") with the leaf `SortableBlock` stubbed out
 *     so the number reflects the wrapper/reconciler floor, not editor
 *     mount cost.
 *  4. Re-render-after-splice time — the incremental re-render once a single
 *     block is inserted, i.e. the steady-state "user created a block" cost
 *     at scale, as opposed to the one-time initial mount.
 *
 * ## Stubbing
 * Mirrors `BlockListRenderer.test.tsx` / `BlockListRendererDragRerender.test.tsx`:
 * `SortableBlock` (the leaf editor row) is mocked to a trivial `<div>` and
 * `@dnd-kit/sortable` / `@dnd-kit/core` are mocked the same way those files do.
 * `BlockListRenderer` itself (and the real `SortableBlockWrapper` it renders
 * per row) is NOT mocked — that wrapper fiber, its `useSyncExternalStore`
 * viewport subscription, and its `React.memo` are exactly the "mounted
 * regardless of viewport" cost the mount envelope bounds, so the bench needs
 * it real to measure anything meaningful.
 *
 * ## What is measured vs what is ASSERTED (#3700)
 * The four timings above are the bench product: they are printed, and the
 * doc table is regenerated from them. They are NOT, any longer, the whole
 * gate.
 *
 * The mount phase used to carry an absolute `mountMs < 10_000` ceiling. That
 * is a wall-clock budget on a shared, unreserved machine, so it measured mount
 * cost PLUS whatever else the box was doing, and the second term is unbounded.
 * #3700 recorded two independent pre-push failures on one day at 12 800 ms and
 * 12 518 ms, both on frontend-only diffs that touch nothing in this render
 * path, both green in isolation (4.1 s), both correctly bypassed with
 * `SKIP_CI_VERIFY`. A gate that is correctly bypassed twice in a day is
 * training people to bypass it.
 *
 * Raising the number was the wrong fix: it was not measuring the wrong
 * threshold, it was measuring the wrong THING. What the budget was standing in
 * for is structural — "mount did not acquire an extra render pass per row" and
 * "mount did not acquire a synchronous layout pass". Both are exact integers,
 * so they are asserted directly and the absolute React-phase wall-clock
 * ceilings are gone:
 *
 *   * `mountRenders === n` — one leaf render per row, no more.
 *   * `rerenderRenders <= n + 1` — inserting one block costs at most one
 *     render per row.
 *   * `mountLayoutReads === 0` — no `getBoundingClientRect` during mount at
 *     any scale.
 *
 * These do not move when the machine is busy. A 500-row page under a 3x load
 * spike still renders 500 times and reads layout 0 times.
 *
 * ## What still uses wall-clock, and why that is defensible
 * The 10K/1K RATIO ceilings stay: an asymptotic regression (an accidental
 * O(n^2) in `buildFlatTree` or the splice path) has no count-based proxy, and
 * a ratio of two measurements taken in the same process is far less exposed to
 * ambient load than a fixed millisecond budget — contention inflates both
 * terms. The two pure-JS phases also keep absolute ceilings, which sit ~3
 * orders of magnitude above their measured cost; see the assertion block for
 * the derivation from the loaded/idle numbers #3700 recorded.
 */

import { cleanup, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import type { BlockRow } from '@/lib/tauri'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'

/**
 * #3700 — the leaf-render counter. `vi.hoisted` so the `vi.mock` factory below
 * (hoisted above the imports) can close over it.
 */
const leafRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => {
    leafRenders.count++
    return <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  },
  INDENT_WIDTH: 24,
}))

vi.mock('@/components/common/EmptyState', () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}))

import { BlockListRenderer } from '@/components/editor/BlockListRenderer'

const noop = () => {}

/** Minimal props to render BlockListRenderer — mirrors BlockListRenderer.test.tsx. */
function makeProps(
  overrides: Partial<React.ComponentProps<typeof BlockListRenderer>> = {},
): React.ComponentProps<typeof BlockListRenderer> {
  return {
    visibleItems: [],
    blocks: [],
    loading: false,
    rootParentId: 'PAGE_1',
    isZoomed: false,
    onExitZoom: noop,
    focusedBlockId: null,
    selectedBlockIds: [] as string[],
    projected: null,
    activeId: null,
    overId: null,
    dropAfter: false,
    viewport: {
      isOffscreen: () => false,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
    },
    rovingEditor: {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    } as never,
    onContainerPointerDown: noop,
    hasChildrenSet: new Set<string>(),
    collapsedIds: new Set<string>(),
    hiddenMountCount: 0,
    onExpandMount: noop,
    ...overrides,
  }
}

/** A flat (unnested — every block at depth 0, parent_id null) page of `n` blocks. */
function makeFlatPage(n: number): BlockRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeBlock({ id: `BLK_${i}`, content: `b${i}`, position: i }),
  )
}

const SCALES = [1_000, 5_000, 10_000] as const

interface ScaleMeasurement {
  n: number
  buildFlatTreeMs: number
  spliceMs: number
  mountMs: number
  rerenderMs: number
  /** #3700 — leaf renders during the initial mount (load-independent). */
  mountRenders: number
  /** #3700 — leaf renders during the post-splice re-render. */
  rerenderRenders: number
  /** #3700 — synchronous layout reads during the initial mount. */
  mountLayoutReads: number
}

/** Times a synchronous callback with `performance.now()`. */
function time(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/**
 * #3700 — count synchronous layout reads (`getBoundingClientRect`) until
 * `stop()`. A per-row layout read during mount is the classic way a render
 * path silently becomes O(n) reflows; unlike wall-clock it is an exact,
 * machine-independent integer.
 */
function countLayoutReads(): { stop: () => number } {
  const original = Element.prototype.getBoundingClientRect
  let reads = 0
  Element.prototype.getBoundingClientRect = function patched(this: Element) {
    reads++
    return original.call(this)
  }
  return {
    stop: () => {
      Element.prototype.getBoundingClientRect = original
      return reads
    },
  }
}

describe('BlockTree scale envelope (#2467 Measure)', () => {
  it('measures buildFlatTree / splice / mount / re-render at 1K, 5K, and 10K blocks/page', () => {
    const measurements: ScaleMeasurement[] = []

    for (const n of SCALES) {
      const rows = makeFlatPage(n)

      // 1. buildFlatTree — group-by-parent + per-group sort + DFS flatten.
      let flat: FlatBlock[] = []
      const buildFlatTreeMs = time(() => {
        flat = buildFlatTree(rows, null)
      })
      expect(flat).toHaveLength(n)

      // 2. Splice cost — store-array copy + insert, mirroring
      // `createBelow`'s `computeSpliced` in page-blocks-reducers.ts.
      const newBlock: FlatBlock = makeBlock({ id: `${n}_NEW`, content: 'new', depth: 0 })
      let spliced: FlatBlock[] = []
      const spliceMs = time(() => {
        spliced = [...flat]
        spliced.splice(Math.floor(n / 2), 0, newBlock)
      })
      expect(spliced).toHaveLength(n + 1)

      // 3. Initial mount — real SortableBlockWrapper fibers (leaf stubbed).
      // #3700: the leaf-render and layout-read counters are reset immediately
      // before each phase, so each phase's counts are its own.
      let renderResult!: ReturnType<typeof render>
      leafRenders.count = 0
      const layoutReads = countLayoutReads()
      const mountMs = time(() => {
        renderResult = render(
          <BlockListRenderer {...makeProps({ visibleItems: flat, blocks: flat })} />,
        )
      })
      const mountRenders = leafRenders.count
      const mountLayoutReads = layoutReads.stop()
      expect(renderResult.getAllByTestId(/^sortable-block-/)).toHaveLength(n)

      // 4. Re-render after splice — the steady-state "one block created on
      // a page this large" cost, as opposed to the one-time initial mount.
      leafRenders.count = 0
      const rerenderMs = time(() => {
        renderResult.rerender(
          <BlockListRenderer {...makeProps({ visibleItems: spliced, blocks: spliced })} />,
        )
      })
      const rerenderRenders = leafRenders.count
      expect(renderResult.getAllByTestId(/^sortable-block-/)).toHaveLength(n + 1)

      renderResult.unmount()
      cleanup()

      measurements.push({
        n,
        buildFlatTreeMs,
        spliceMs,
        mountMs,
        rerenderMs,
        mountRenders,
        rerenderRenders,
        mountLayoutReads,
      })
    }

    // Print the measured envelope so `vitest run` output carries the real
    // numbers this bench exists to produce (matches the doc table in
    // editor-and-content.md § Mount envelope — regenerate that table from
    // this output when re-running the bench).
    console.table(
      measurements.map((m) => ({
        blocks: m.n,
        'buildFlatTree (ms)': m.buildFlatTreeMs.toFixed(2),
        'splice (ms)': m.spliceMs.toFixed(2),
        'mount (ms)': m.mountMs.toFixed(2),
        're-render (ms)': m.rerenderMs.toFixed(2),
        'mount renders': m.mountRenders,
        're-render renders': m.rerenderRenders,
        'mount layout reads': m.mountLayoutReads,
      })),
    )

    // ── Assertions ──────────────────────────────────────────────────────
    // #3700 — the React-phase guards are COUNTS, not wall-clock. See the
    // header for why. Each is an exact integer that depends on the render
    // path and on nothing else the machine happens to be doing.
    const first = measurements[0]
    const last = measurements.at(-1)
    if (!first || !last) throw new Error('expected measurements for every scale')

    for (const m of measurements) {
      // Mount renders EXACTLY one leaf per row. More than that means an extra
      // render pass — a cascading state update during mount, a broken
      // `React.memo`, a StrictMode-style double-invoke — which is the
      // constant-factor blowup the old 10 s mount budget was standing in for.
      // Fewer is impossible: every row must mount once.
      expect(m.mountRenders).toBe(m.n)

      // Inserting ONE block re-renders AT MOST one leaf per row. `<=` rather
      // than `===`: the current renderer re-renders every row (the fresh props
      // object invalidates each wrapper's memo), so the measured value is
      // `n + 1`, but tightening memoization would legitimately drive this DOWN
      // and must not fail the gate. Doubling it — a second reconciliation pass
      // per insert — must.
      expect(m.rerenderRenders).toBeLessThanOrEqual(m.n + 1)

      // Mount performs NO synchronous layout reads at any scale (measured 0 at
      // 1K/5K/10K). This is the other regression the mount budget was proxying
      // for: a per-row `getBoundingClientRect` is O(n) forced reflows in a real
      // browser and would barely register in happy-dom's wall clock, so the
      // count catches what the timer could not.
      expect(m.mountLayoutReads).toBe(0)

      // The two pure-JS phases keep their absolute ceilings. They are three
      // orders of magnitude under them (measured idle: buildFlatTree
      // 0.5-1.5 ms, splice 0.02-8.8 ms), so even at the ~3.1x slowdown #3700
      // observed under concurrent Rust builds (12 800 ms vs 4 100 ms idle for
      // the same phase) the worst case is ~5 ms and ~27 ms — 18x and 7x under
      // these ceilings. Unlike the React phases, contention cannot plausibly
      // close that gap.
      expect(m.buildFlatTreeMs).toBeLessThan(500)
      expect(m.spliceMs).toBeLessThan(200)
    }

    // Sub-quadratic trend: 10x more blocks should not cost anywhere near
    // 10x^2 (100x) more time. A ~40x ceiling comfortably separates linear/
    // n-log-n growth from a real O(n^2) regression; measured idle 10K/1K
    // ratios are ~2.6x (buildFlatTree), ~4.8x (mount) and ~8.5x (re-render).
    //
    // #3700 kept these while dropping the absolute wall-clock ceilings: a
    // RATIO of two measurements taken seconds apart in the same process is far
    // less exposed to ambient load than a fixed millisecond budget, because
    // contention inflates numerator and denominator together. It is not
    // immune — a burst landing on the 10K phase alone would skew it — but it
    // would take a ~5x differential inflation to reach the ceiling, against
    // the fixed 10 s budget that a uniform ~3.1x slowdown was already enough
    // to breach twice in one day.
    const scaleFactor = last.n / first.n
    const superlinearCeiling = scaleFactor * 4

    expect(last.buildFlatTreeMs).toBeLessThan(
      Math.max(first.buildFlatTreeMs * superlinearCeiling, 50),
    )
    expect(last.spliceMs).toBeLessThan(Math.max(first.spliceMs * superlinearCeiling, 50))
    expect(last.mountMs).toBeLessThan(Math.max(first.mountMs * superlinearCeiling, 200))
    expect(last.rerenderMs).toBeLessThan(Math.max(first.rerenderMs * superlinearCeiling, 200))

    // #3700 — the per-test timeout is a SAFETY NET, not a budget, so it is
    // sized for the worst contention actually observed rather than for a
    // typical run. Derivation: the whole test measures ~4.4 s idle here, of
    // which the 10K mount is ~1.0 s, i.e. total ≈ 4.6x that one phase. #3700
    // recorded a 10K mount of 4.1 s idle / 12.8 s under load on a busier box,
    // which extrapolates to ≈19 s idle and ≈58 s under the same contention.
    // 120 s is ~2x that worst case. (The old 30 s would have TIMED OUT there
    // once the mount assertion stopped firing first — trading one spurious
    // failure mode for another.)
  }, 120_000)
})
