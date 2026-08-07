/**
 * Tests for the code-block renderer:
 *  - highlight size cap (#747 item 3): above `HIGHLIGHT_MAX_LENGTH` we render
 *    plain text instead of running the O(grammars × length) highlighter.
 *  - deferred highlighting + output cache (#2271): first paint is plain and
 *    upgrades post-commit; a cache hit paints highlighted synchronously.
 *
 * Because highlighting is now deferred off the critical path, an uncached block
 * has NO `hljs-` spans on first paint — assertions that expect highlighting must
 * `waitFor` the post-effect upgrade.
 */

import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  __highlightCacheStats,
  clearHighlightCache,
  HIGHLIGHT_MAX_LENGTH,
  peekHighlightCache,
  renderCodeBlock,
  writeHighlightCache,
} from '@/components/RichContentRenderer/marks/code'
import type { CodeBlockNode } from '@/editor/types'

function codeBlock(text: string, language: string | null = null): CodeBlockNode {
  return {
    type: 'codeBlock',
    attrs: { language },
    content: [{ type: 'text', text }],
  }
}

const hljsSpans = (container: HTMLElement) => container.querySelectorAll('span[class*="hljs-"]')

beforeEach(() => {
  // Flush the module-level highlight cache so a prior test's cached tree does
  // not paint highlighted synchronously and mask the deferred-upgrade path.
  clearHighlightCache()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('renderCodeBlock — highlight size cap (#747 item 3)', () => {
  it('highlights small code blocks (hljs spans appear after the deferred upgrade)', async () => {
    const block = codeBlock('const x: number = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
    // Source text is preserved.
    expect(container.querySelector('code')?.textContent).toContain('const x')
  })

  it('highlights small code blocks via highlightAuto when no language is set', async () => {
    const block = codeBlock('def greet():\n    return "hi"\n', null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
  })

  it('falls back to PLAIN TEXT above the cap — no highlight spans (auto path)', async () => {
    // A >cap input that WOULD otherwise produce highlight spans if processed.
    const huge = 'const value = 42;\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 18) + 100)
    expect(huge.length).toBeGreaterThan(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(huge, null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    // No highlighting applied — plain on first paint AND after the effect flush
    // (computeHighlight short-circuits over the cap and caches "plain").
    await waitFor(() => {
      expect(container.querySelector('code')?.textContent).toContain('const value = 42;')
    })
    expect(hljsSpans(container)).toHaveLength(0)
  })

  it('falls back to plain text above the cap on the explicit-language path too', async () => {
    const huge = 'fn main() {}\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 13) + 100)
    expect(huge.length).toBeGreaterThan(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(huge, 'rust')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    await waitFor(() => {
      expect(container.querySelector('code')?.textContent).toContain('fn main()')
    })
    expect(hljsSpans(container)).toHaveLength(0)
  })

  it('still highlights a block right at the cap boundary', async () => {
    // #3541 — this test used to build its cap-length body out of `// x\n`
    // repeated ~6000 times. That is the same LENGTH as the body below (what
    // the cap actually gates on: `code.length > HIGHLIGHT_MAX_LENGTH`) but a
    // wildly different amount of DOWNSTREAM work: ~6000 highlight tokens
    // became ~6000 React `<span>`s built into happy-dom in one synchronous
    // commit. Measured locally that commit — not the highlighter — dominated
    // the test: ~1.9 s wall-clock, of which `lowlight.highlight` was ~53 ms
    // and the dynamic `import()` ~98 ms. Racing ~1.9 s of blocking CPU work
    // against `waitFor`'s 8000 ms real-timer budget leaves only ~4x headroom,
    // which a low-core-count runner under contention can and did eat.
    //
    // Token COUNT is irrelevant to the cap logic, so keep the length at the
    // boundary and drop the token count: long comment lines give the same
    // "exactly at the cap, highlighting still runs" assertion with ~152 spans
    // instead of ~6000, measured at ~80 ms instead of ~1900 ms (~20x more
    // headroom). Nothing about the path under test is stubbed — the real
    // `scheduleIdle` still defers through its real `setTimeout(cb, 0)`
    // fallback (happy-dom has no `requestIdleCallback`), the real dynamic
    // `import('@/lib/lowlight-curated')`, `lowlight.highlight`, cache write
    // and `setState` all still run.
    const filler = `// ${'x'.repeat(196)}\n`
    let body = 'const x = 1;\n'
    while (body.length + filler.length <= HIGHLIGHT_MAX_LENGTH) body += filler
    // Pad the tail so the body lands ON the cap, not near it. The guard is
    // `code.length > HIGHLIGHT_MAX_LENGTH`, so the largest still-highlighted
    // input is exactly HIGHLIGHT_MAX_LENGTH — and only that value distinguishes
    // `>` from `>=`. The previous filler stopped at 29 998, where flipping the
    // comparison changes nothing and this test stayed green.
    const remaining = HIGHLIGHT_MAX_LENGTH - body.length
    if (remaining >= 4) body += `// ${'x'.repeat(remaining - 4)}\n`
    // Exact, not a band: the construction above is deterministic, so a future
    // edit that drifts the body off the boundary must redden here rather than
    // silently downgrade this to a comfortably-under-the-cap test.
    expect(body.length).toBe(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(body, 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    // Deferred off the first paint (same invariant the #2271 tests pin).
    expect(hljsSpans(container)).toHaveLength(0)

    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
  })

  it('has no axe violations (highlighted block after upgrade)', async () => {
    const block = codeBlock('const x = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)
    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (plain-text fallback above the cap)', async () => {
    const huge = 'log line here\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 14) + 100)
    const block = codeBlock(huge, null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('renderCodeBlock — deferred highlighting + output cache (#2271)', () => {
  it('renders plain text on first paint, then upgrades to highlighted post-commit', async () => {
    const block = codeBlock('const x: number = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    // First paint: no highlight spans yet (highlighting deferred off the
    // critical path), but the source text is already visible.
    expect(hljsSpans(container)).toHaveLength(0)
    expect(container.querySelector('code')?.textContent).toContain('const x')

    // Post-commit upgrade.
    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
  })

  it('arms a real timer for the deferred upgrade (idle deferral is not silently inlined)', async () => {
    // #3557 — the "plain on first paint, then upgrades" assertions above pass
    // even if `scheduleIdle` is deleted and its callback invoked inline: the
    // dynamic `import('@/lib/lowlight-curated')` promise alone defers past
    // RTL's synchronous `act()`, so those assertions never actually exercise
    // the idle scheduling. Pin the thing that vanishes when the deferral is
    // deleted — a timer actually gets ARMED — by checking `vi.getTimerCount()`
    // BEFORE running any timers.
    vi.useFakeTimers()
    const block = codeBlock('const x: number = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    // This assertion is only meaningful while `scheduleIdle` takes its
    // `setTimeout` fallback, which happens because happy-dom does not implement
    // `requestIdleCallback`. Pin that precondition explicitly: if a happy-dom
    // bump ever adds the API, `scheduleIdle` takes the rIC branch, no fake timer
    // is armed, and the assertion below would go red claiming the deferral was
    // inlined — blaming the wrong thing. This line makes that failure name
    // itself instead.
    expect(typeof requestIdleCallback).toBe('undefined')

    // A real deferral arms a real timer synchronously on mount, before that
    // timer ever fires.
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    act(() => {
      vi.runOnlyPendingTimers()
    })
    // NB: `vi.waitFor` (not RTL's `waitFor`, which requires a global `jest`
    // vitest's fake-timer branch does not provide). `vi.waitFor` uses
    // `getSafeTimers()` internally — REAL timers — so it composes with the fake
    // timers installed above.
    //
    // The explicit 8000ms matches `asyncUtilTimeout` in `src/test-setup.ts`,
    // which was raised from the default precisely because this suite flaked
    // under pre-push CPU contention (vitest + cargo nextest saturating cores).
    // `vi.waitFor` does NOT read that setting — it defaults to 1000ms — and the
    // work being awaited here is a dynamic `import()` plus `lowlight.highlight`
    // plus a React commit. Leaving the default would reintroduce exactly the
    // contention flake #3541 removed from this file.
    await vi.waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0), {
      timeout: 8000,
    })
  })

  it('paints highlighted SYNCHRONOUSLY on a cache hit (no flicker on re-render)', async () => {
    const block = codeBlock('const y: number = 2', 'typescript')

    // Prime the cache: render once and let the deferred highlight populate it.
    const first = render(<>{renderCodeBlock(block, 'k')}</>)
    await waitFor(() => expect(hljsSpans(first.container).length).toBeGreaterThan(0))
    first.unmount()

    // A fresh render of identical (language, code) must be highlighted on the
    // FIRST synchronous paint — no waitFor.
    const second = render(<>{renderCodeBlock(block, 'k2')}</>)
    expect(hljsSpans(second.container).length).toBeGreaterThan(0)
  })

  it('auto-detection path also upgrades and caches', async () => {
    const block = codeBlock('def greet():\n    return "hi"\n', null)

    const first = render(<>{renderCodeBlock(block, 'k')}</>)
    expect(hljsSpans(first.container)).toHaveLength(0) // deferred
    await waitFor(() => expect(hljsSpans(first.container).length).toBeGreaterThan(0))
    first.unmount()

    const second = render(<>{renderCodeBlock(block, 'k2')}</>)
    expect(hljsSpans(second.container).length).toBeGreaterThan(0) // cache hit, sync
  })

  it('re-renders with NEW code when the same component instance receives different props', async () => {
    // React keys for code blocks are positional (`b-${bIdx}`), so the same
    // HighlightedCode instance can be reused for DIFFERENT code — an edited
    // block, or a sibling deletion shifting the next code block into the slot.
    // The committed output must always match the current `code` prop, never a
    // previously-highlighted tree (review fix for #2271).
    const first = codeBlock('const first = 1', 'typescript')
    const second = codeBlock('let second = 2', 'typescript')

    const { container, rerender } = render(<>{renderCodeBlock(first, 'k')}</>)
    await waitFor(() => expect(hljsSpans(container).length).toBeGreaterThan(0))
    expect(container.querySelector('code')?.textContent).toContain('const first')

    // Same positional key, different code → instance reused with new props.
    rerender(<>{renderCodeBlock(second, 'k')}</>)

    // Synchronously after commit the OLD code must be gone and the new code
    // visible (plain or highlighted — content correctness is the invariant).
    expect(container.querySelector('code')?.textContent).toContain('let second')
    expect(container.querySelector('code')?.textContent).not.toContain('const first')

    // And the deferred upgrade highlights the NEW code.
    await waitFor(() => {
      expect(hljsSpans(container).length).toBeGreaterThan(0)
      expect(container.querySelector('code')?.textContent).toContain('let second')
    })
  })

  it('a literal language "auto" does not poison the auto-detect cache entry', async () => {
    const code = 'def greet():\n    return "hi"\n'

    // language="auto" is not a registered grammar → highlighter throws →
    // cached as "known plain" under the explicit-language namespace.
    const bogus = render(<>{renderCodeBlock(codeBlock(code, 'auto'), 'k')}</>)
    await waitFor(() => {
      expect(bogus.container.querySelector('code')?.textContent).toContain('def greet')
    })
    expect(hljsSpans(bogus.container)).toHaveLength(0)
    bogus.unmount()

    // The auto-DETECT path for the same code must still highlight — its cache
    // key lives in a separate namespace from the bogus explicit language.
    const auto = render(<>{renderCodeBlock(codeBlock(code, null), 'k2')}</>)
    await waitFor(() => expect(hljsSpans(auto.container).length).toBeGreaterThan(0))
  })

  it('oversized block stays plain synchronously on a cache hit too', async () => {
    const huge = 'const value = 42;\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 18) + 100)
    const block = codeBlock(huge, 'typescript')

    // Prime: the over-cap block is cached as "known plain".
    const first = render(<>{renderCodeBlock(block, 'k')}</>)
    // Let the deferred effect run and record the "plain" cache entry.
    await waitFor(() => {
      expect(first.container.querySelector('code')?.textContent).toContain('const value = 42;')
    })
    first.unmount()

    const second = render(<>{renderCodeBlock(block, 'k2')}</>)
    expect(hljsSpans(second.container)).toHaveLength(0)
  })
})

describe('highlight cache byte budget (#2289)', () => {
  // Mirrors HIGHLIGHT_CACHE_MAX_BYTES / HIGHLIGHT_CACHE_MAX in ../code (kept in
  // sync deliberately — the cache is bounded by BOTH). These tests drive the
  // cache directly with "known plain" (null) entries whose byte proxy is just
  // `code.length`, so we can control accumulated bytes precisely.
  const BUDGET_BYTES = 4 * 1024 * 1024
  const ENTRY_CAP = 300

  it('evicts by byte budget before the entry cap when entries are large', () => {
    // ~1 MB per entry → a handful blow past the ~4 MB byte ceiling with far
    // fewer than 300 entries, so ONLY the byte bound can be doing the eviction.
    const bigLen = 1_000_000
    const bodies = Array.from({ length: 8 }, (_, i) => `${i}:${'x'.repeat(bigLen)}`)

    for (const body of bodies) writeHighlightCache(body, 'plaintext', null)

    const { entries, bytes } = __highlightCacheStats()
    // Byte-based eviction fired: far fewer than the entry cap are retained.
    expect(entries).toBeLessThan(ENTRY_CAP)
    expect(entries).toBeLessThanOrEqual(4)
    // Accumulated proxy-bytes never exceed the ceiling.
    expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES)

    // Oldest inserted entry was evicted; the newest survives (LRU order).
    expect(peekHighlightCache(bodies.at(0) ?? '', 'plaintext')).toBeUndefined()
    expect(peekHighlightCache(bodies.at(-1) ?? '', 'plaintext')).not.toBeUndefined()
  })

  it('always admits a single entry even if it alone exceeds the budget', () => {
    const huge = 'y'.repeat(BUDGET_BYTES + 1000)
    writeHighlightCache(huge, 'plaintext', null)

    const { entries, bytes } = __highlightCacheStats()
    expect(entries).toBe(1)
    expect(bytes).toBe(huge.length) // over budget, but the lone entry is kept
    expect(peekHighlightCache(huge, 'plaintext')).not.toBeUndefined()
  })

  it('enforces the entry cap independently when entries are tiny', () => {
    // Tiny entries: total bytes stay far under the byte budget, so ONLY the
    // count cap can bound the cache.
    for (let i = 0; i < ENTRY_CAP + 25; i++) {
      writeHighlightCache(`snippet-${i}`, 'plaintext', null)
    }

    const { entries, bytes } = __highlightCacheStats()
    expect(entries).toBe(ENTRY_CAP)
    expect(bytes).toBeLessThan(BUDGET_BYTES)

    // Oldest evicted, newest retained.
    expect(peekHighlightCache('snippet-0', 'plaintext')).toBeUndefined()
    expect(peekHighlightCache(`snippet-${ENTRY_CAP + 24}`, 'plaintext')).not.toBeUndefined()
  })

  it('keeps byte accounting correct across a recency refresh (no double count)', () => {
    const body = 'z'.repeat(500)
    writeHighlightCache(body, 'plaintext', null)
    expect(__highlightCacheStats()).toEqual({ entries: 1, bytes: 500 })

    // Re-writing the identical (code, language) refreshes recency only; bytes
    // must not accumulate.
    writeHighlightCache(body, 'plaintext', null)
    expect(__highlightCacheStats()).toEqual({ entries: 1, bytes: 500 })
  })

  it('clearHighlightCache() resets both entry and byte accounting', () => {
    writeHighlightCache('a'.repeat(1000), 'plaintext', null)
    writeHighlightCache('b'.repeat(2000), 'plaintext', null)
    expect(__highlightCacheStats()).toEqual({ entries: 2, bytes: 3000 })

    clearHighlightCache()
    expect(__highlightCacheStats()).toEqual({ entries: 0, bytes: 0 })

    // Fresh inserts start from zero.
    writeHighlightCache('c'.repeat(42), 'plaintext', null)
    expect(__highlightCacheStats()).toEqual({ entries: 1, bytes: 42 })
  })
})
