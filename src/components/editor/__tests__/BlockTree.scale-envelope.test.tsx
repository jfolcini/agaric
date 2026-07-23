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
 * ## Why the ceilings are loose
 * These are wall-clock measurements on shared CI hardware (happy-dom, no
 * GPU/layout), so absolute numbers vary run to run. Matching this repo's
 * existing timing-test convention (see
 * `markdown-serializer.test.ts`'s "hardening: link scan depth" describe
 * block), the assertions are sized to distinguish "the expected regime" from
 * "a real regression" (e.g. an accidental O(n^2) reintroduced into
 * `buildFlatTree` or the splice path) rather than to pin exact numbers — a
 * ~10x scale step (1K -> 10K) should cost roughly ~10x for linear work; the
 * ratio ceilings below give several times that headroom before failing.
 */

import { cleanup, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import type { BlockRow } from '@/lib/tauri'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
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
}

/** Times a synchronous callback with `performance.now()`. */
function time(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
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
      let renderResult!: ReturnType<typeof render>
      const mountMs = time(() => {
        renderResult = render(
          <BlockListRenderer {...makeProps({ visibleItems: flat, blocks: flat })} />,
        )
      })
      expect(renderResult.getAllByTestId(/^sortable-block-/)).toHaveLength(n)

      // 4. Re-render after splice — the steady-state "one block created on
      // a page this large" cost, as opposed to the one-time initial mount.
      const rerenderMs = time(() => {
        renderResult.rerender(
          <BlockListRenderer {...makeProps({ visibleItems: spliced, blocks: spliced })} />,
        )
      })
      expect(renderResult.getAllByTestId(/^sortable-block-/)).toHaveLength(n + 1)

      renderResult.unmount()
      cleanup()

      measurements.push({ n, buildFlatTreeMs, spliceMs, mountMs, rerenderMs })
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
      })),
    )

    // ── Assertions ──────────────────────────────────────────────────────
    // Every metric must stay under a generous absolute ceiling at every
    // scale (catches an absolute-terms regression, e.g. an accidental
    // synchronous IPC or O(n^2) creeping into any of these paths) AND the
    // 10K/1K ratio must stay well under what an O(n^2) blowup would produce
    // (catches an asymptotic regression even if the 1K number also grew).
    // Linear work over a 10x scale step costs ~10x; the ratio ceilings below
    // give ~4-8x headroom over that before failing, matching this repo's
    // "distinguish regimes, don't pin exact numbers" timing-test convention
    // (see markdown-serializer.test.ts's link-scan-depth hardening test).
    const first = measurements[0]
    const last = measurements.at(-1)
    if (!first || !last) throw new Error('expected measurements for every scale')

    for (const m of measurements) {
      // Absolute ceilings, sized for CI jitter on shared hardware.
      expect(m.buildFlatTreeMs).toBeLessThan(500)
      expect(m.spliceMs).toBeLessThan(200)
      expect(m.mountMs).toBeLessThan(10_000)
      expect(m.rerenderMs).toBeLessThan(10_000)
    }

    // Sub-quadratic trend: 10x more blocks should not cost anywhere near
    // 10x^2 (100x) more time. A ~40x ceiling comfortably separates linear/
    // n-log-n growth (expected ~10-15x here) from a real O(n^2) regression.
    const scaleFactor = last.n / first.n
    const superlinearCeiling = scaleFactor * 4

    expect(last.buildFlatTreeMs).toBeLessThan(
      Math.max(first.buildFlatTreeMs * superlinearCeiling, 50),
    )
    expect(last.spliceMs).toBeLessThan(Math.max(first.spliceMs * superlinearCeiling, 50))
    expect(last.mountMs).toBeLessThan(Math.max(first.mountMs * superlinearCeiling, 200))
    expect(last.rerenderMs).toBeLessThan(Math.max(first.rerenderMs * superlinearCeiling, 200))
  }, 30_000)
})
