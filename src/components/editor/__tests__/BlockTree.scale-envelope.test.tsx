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
 * table in `docs/architecture/editor-and-content.md` § "Mount envelope" is a
 * transcription of one such run. Running this file does NOT refresh that
 * table, and the absolute milliseconds are hardware-dependent — see the
 * provenance note printed under it. They are NOT, any longer, the whole gate.
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
 * ## What used to still use wall-clock, and why it no longer does (#4013)
 * #3700 kept 10K/1K RATIO ceilings for the asymptotic regressions that have no
 * render-count proxy (an accidental O(n^2) in the flatten path), on the sound
 * ground that a ratio of two measurements taken in the same process is far
 * less exposed to ambient load than a fixed millisecond budget — contention
 * inflates numerator and denominator together.
 *
 * The assertions then wrapped each ratio in a FLOOR:
 * `expect(last.buildFlatTreeMs).toBeLessThan(Math.max(first * 40, 50))`.
 * `buildFlatTree` measures 0.4-2 ms here, so `first * 40` is ~17-80 ms and the
 * floor dominated in the common case. The effective bound was a fixed 50 ms
 * wall-clock budget — precisely the thing #3700 says it removed — and it fired
 * as `expected 229.25 to be less than 50` on a full-suite parallel run while
 * the same file passed alone in 3.57 s (#4013). A guard whose verdict depends
 * on what else the box is doing is not evidence in either direction.
 *
 * The fix is NOT a third guess at that constant. All four wall-clock ceilings
 * (and the two absolute pure-JS ones) are GONE, and the asymptotic regression
 * they stood in for is now an exact, load-invariant COUNT — see the
 * `asymptotic work` test at the bottom of this file. The timings are still
 * measured and printed, because they are the bench PRODUCT this file exists to
 * produce and the source the doc table is transcribed from; they are simply no
 * longer a gate. A quantity this machine-dependent can be reported honestly or
 * asserted honestly, not both.
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

/**
 * #4013 — replace each row with a structurally identical object whose own
 * enumerable properties are counting getters, and tally every read.
 *
 * This is the load-invariant stand-in for the wall-clock ratio ceilings this
 * file used to carry: an O(n^2) rewrite of a flatten/lookup path touches the
 * input rows O(n) times per row instead of O(1), which the tally shows as an
 * exact integer that ambient CPU contention cannot move. Getters are
 * `enumerable` + `configurable` so `{...row}` spreads and `Object.entries`
 * behave exactly as they do on the plain rows — including invoking (and
 * therefore counting) every getter.
 *
 * Deliberately NOT applied to the timed measurement pass above: a getter call
 * is slower than a property load, and those timings are the bench product.
 */
function countFieldReads<T extends object>(
  rows: readonly T[],
): {
  rows: T[]
  reads: () => number
} {
  let reads = 0
  const instrumented = rows.map((row) => {
    const probe = {} as Record<string, unknown>
    for (const [key, value] of Object.entries(row)) {
      Object.defineProperty(probe, key, {
        enumerable: true,
        configurable: true,
        get() {
          reads++
          return value
        },
      })
    }
    return probe as T
  })
  return { rows: instrumented, reads: () => reads }
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
    // numbers this bench exists to produce. The table in editor-and-content.md
    // § Mount envelope is a transcription of ONE such run on CI-class
    // hardware, not a live view of this output: the absolute milliseconds move
    // several-fold with machine and load (see the provenance note there), so
    // refresh it deliberately, and record which machine, rather than assuming
    // it tracks whatever this run printed.
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
    // #3700 / #4013 — every guard here is a COUNT, not wall-clock. See the
    // header for why. Each is an exact integer that depends on the render
    // path and on nothing else the machine happens to be doing.
    expect(measurements).toHaveLength(SCALES.length)

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

      // #4013 — the four wall-clock ceilings that used to live here
      // (`buildFlatTreeMs < 500`, `spliceMs < 200`, and the two
      // `Math.max(first * 40, floor)` ratio bounds) are gone. `buildFlatTreeMs`
      // was measured at 229.25 ms on a loaded box against a 500 ms bound and
      // 50 ms floor; a threshold that a passing run already sits within 2.2x of
      // is a coin toss, not a gate. The asymptotic property they proxied for is
      // asserted exactly, in counts, by the `asymptotic work` test below.
    }

    // The per-test timeout is a SAFETY NET, not a budget, so it is sized for
    // the worst contention actually observed rather than for a typical run.
    // Derivation: on this box the whole test measures ~2.3-3.0 s with the
    // machine near idle, of which the 10K mount is ~0.7-0.8 s, i.e. total ≈
    // 3-4x that one phase. Re-run at load average 22 on 16 cores it took
    // 8.6-9.1 s with the 10K mount at 2.6-2.9 s — a ~3.9x inflation, still 13x
    // inside this timeout. #3700 recorded a 10K mount of 4.1 s idle / 12.8 s
    // under load on a busier box, which extrapolates to ≈16 s idle and ≈51 s
    // under the same contention. 120 s is
    // ~2.4x that worst case. Since #4013 removed the wall-clock assertions
    // this is now the ONLY way slowness can fail the file — deliberately, and
    // only at an order of magnitude beyond anything yet seen.
  }, 120_000)

  /**
   * #4013 — the asymptotic guard, as an exact load-invariant COUNT.
   *
   * What the removed wall-clock ratios were for: catching a change of
   * ALGORITHMIC CLASS that the render counters cannot see. The two canonical
   * forms are dropping `buildFlatTree`'s `childrenMap` for a per-parent
   * `allBlocks.filter(...)` scan, and adding a per-row O(n) lookup inside the
   * mount path. `mountRenders === n` still holds under both, which is why
   * #3700 kept a clock here at all.
   *
   * But that class change does have an exact proxy: how many times the code
   * TOUCHES the input rows. Each row is replaced by an object whose own
   * properties are counting getters, so every read `buildFlatTree` performs on
   * a row — and every per-row prop read React performs during mount and
   * re-render — is tallied. The tally is a property of the code path and of
   * nothing else: it is byte-identical whatever else the machine is doing,
   * which is the property the wall clock could never have.
   *
   * Measured on this fixture (a flat page — one already-sorted sibling group):
   *
   *   buildFlatTree   7n - 2 reads ->  6.998 /  7.000 /  7.000 per block
   *   mount          34n     reads -> 34.000 / 34.000 / 34.000 per block
   *   re-render      34n     reads -> 34.000 / 34.000 / 34.000 per block
   *
   * at n = 1K / 5K / 10K — exact at every scale (6 998 / 34 998 / 69 998 build
   * reads, 34 000 / 170 000 / 340 000 mount reads, the same again on
   * re-render).
   *
   * The `7n - 2` decomposes term by term, and it is worth being exact about
   * which reads are in it, because the arithmetic is the argument:
   *
   *    n       `block.parent_id`, once per row, in the group-by-parent pass.
   *   2n - 2   `a.position` / `b.position` in the sort comparator. The group
   *            arrives already ascending, so V8's TimSort settles it in a
   *            single run of n - 1 comparisons (999 at 1K, 9 999 at 10K) at
   *            2 reads each.
   *   3n       `child.id`, three times per row in the DFS: `visited.has`,
   *            `visited.add`, and the recursive `dfs(child.id, depth + 1)`.
   *    n       `child.depth`, in the identity-preserving test at
   *            `tree-utils.ts:101`.
   *
   * What is NOT in that list is the `{...child, depth}` spread on that same
   * line: it never runs on this fixture. `makeBlock` defaults `depth: 0` and
   * `makeFlatPage` never overrides it, so `'depth' in child &&
   * flatChild.depth === depth` holds for every row and `buildFlatTree` returns
   * the input objects themselves (`in` is a HasProperty check and does not
   * invoke the getter, so that test costs exactly the one `depth` read counted
   * above). The measurement rules the spread out on its own: `makeBlock` has
   * 12 own properties, so spreading each row would add 12 reads/block and put
   * the total near 18-19n, not the observed 6.998. The probe WOULD see such a
   * spread if a change introduced one — that is why `countFieldReads` makes
   * its getters enumerable — which is the point of counting rather than
   * assuming.
   *
   * Mount and re-render tally the same 34n because the fixture hands React a
   * fresh props object on the re-render: every `SortableBlockWrapper` memo is
   * busted, so the re-render re-reads exactly what the mount read. The one
   * extra block spliced in for the re-render is a plain `makeBlock` row rather
   * than an instrumented one, so it contributes nothing to the tally.
   *
   * Every figure above is an exact multiple of n, reproduced digit-for-digit
   * on each run taken here. Load-invariance is what the #4013 experiment
   * established: 10 consecutive runs — 5 idle, 5 under a deliberate 48-way CPU
   * load spike on a 16-core box — inflated the 10K MOUNT wall-clock from
   * ~0.78 s to 6.0-7.6 s (~8x) and did not move the asserted ratio by a single
   * digit. The 5K column was taken with the same instrumentation at the middle
   * scale; the assertion itself needs only the endpoints.
   *
   * So the asserted quantity — reads per block at 10K divided by reads per
   * block at 1K — measures 1.000. The ceiling is 2, derived: the largest
   * legitimate growth a comparison sort can add across this 10x span is
   * log2(10 000) / log2(1 000) = 1.33x (and only 2 of `buildFlatTree`'s 7
   * reads per block are comparisons, so the realised figure is well under
   * that), while ANY quadratic term drives the same quantity to ~10x. 2 sits
   * 1.5x above the worst legitimate value and 5x below the smallest regression
   * signal. Verified by injecting the filter-per-parent rewrite into
   * `buildFlatTree`: reads per block became 1 009.996 at 1K and 10 010.000 at
   * 10K, failing as `expected 9.910929944277006 to be less than 2`.
   *
   * The splice phase has NO assertion, here or above, deliberately: the test
   * inlines `[...flat]` + `Array.prototype.splice`, so no repository code runs
   * in it and a "guard" on it could only ever fail for reasons no change to
   * this codebase can cause. It stays in the printed table as a cost datum.
   */
  it('bounds asymptotic work with load-invariant field-read counts', () => {
    // Only the ratio endpoints — the middle scale adds cost without adding
    // signal, and the printed measurement above already covers 5K.
    const WORK_SCALES = [SCALES[0], SCALES.at(-1) as number] as const

    const work = WORK_SCALES.map((n) => {
      // 1. buildFlatTree over counting rows.
      const build = countFieldReads(makeFlatPage(n))
      const instrumentedFlat = buildFlatTree(build.rows, null)
      const buildReads = build.reads()
      expect(instrumentedFlat).toHaveLength(n)

      // 2. Mount / re-render over counting rows, on a FRESH counter. Note the
      // reason: on this fixture `buildFlatTree` hands back the very objects it
      // was given (the identity-preserving branch — see the block comment
      // above), so re-instrumenting is not about object identity. It is what
      // gives the mount phase a counter that starts at zero instead of at
      // `buildFlatTree`'s 7n - 2.
      const tree = countFieldReads(buildFlatTree(makeFlatPage(n), null))
      const rows = tree.rows
      const renderResult = render(
        <BlockListRenderer {...makeProps({ visibleItems: rows, blocks: rows })} />,
      )
      const mountReads = tree.reads()

      // Building `spliced` reads no row property — the array spread copies
      // references and `Array.prototype.splice` moves them — so `mountReads`
      // is still the running total here and is what the re-render subtracts.
      const spliced = [...rows]
      spliced.splice(Math.floor(n / 2), 0, makeBlock({ id: `${n}_NEW`, content: 'new', depth: 0 }))
      renderResult.rerender(
        <BlockListRenderer {...makeProps({ visibleItems: spliced, blocks: spliced })} />,
      )
      const rerenderReads = tree.reads() - mountReads

      renderResult.unmount()
      cleanup()

      return { n, buildReads, mountReads, rerenderReads }
    })

    console.table(
      work.map((w) => ({
        blocks: w.n,
        'buildFlatTree reads/block': (w.buildReads / w.n).toFixed(3),
        'mount reads/block': (w.mountReads / w.n).toFixed(3),
        're-render reads/block': (w.rerenderReads / w.n).toFixed(3),
      })),
    )

    const small = work[0]
    const large = work.at(-1)
    if (!small || !large) throw new Error('expected work measurements at both endpoints')

    /**
     * Work per block must not grow with n. See the derivation above for why
     * the ceiling is 2 and not a wider number: this quantity has zero
     * measured spread, so the headroom is sized against legitimate
     * ALGORITHMIC change, not against machine noise.
     */
    const SUPERLINEAR_CEILING = 2
    const perBlockGrowth = (a: number, b: number) => b / large.n / (a / small.n)

    expect(perBlockGrowth(small.buildReads, large.buildReads)).toBeLessThan(SUPERLINEAR_CEILING)
    expect(perBlockGrowth(small.mountReads, large.mountReads)).toBeLessThan(SUPERLINEAR_CEILING)
    expect(perBlockGrowth(small.rerenderReads, large.rerenderReads)).toBeLessThan(
      SUPERLINEAR_CEILING,
    )

    // A row that is never touched would make the ratio vacuously 1: pin that
    // the instrumentation actually observed work at both endpoints, so the
    // guard cannot pass by measuring nothing (which is the whole failure mode
    // #4013 is about).
    for (const w of work) {
      expect(w.buildReads).toBeGreaterThan(w.n)
      expect(w.mountReads).toBeGreaterThan(w.n)
      expect(w.rerenderReads).toBeGreaterThan(w.n)
    }
  }, 120_000)
})
