/**
 * Unit tests for the in-page find matcher.
 *
 * Covers:
 *  - Literal scanning with case sensitivity and whole-word toggles.
 *  - Regex compilation, error surfacing, and pattern-length cap.
 *  - Text-node skipping at 10 KB in regex mode.
 *  - Cooperative chunked walker (`runWalker`) — completion path,
 *    progress callback emission, and cancellation.
 *  - Text-node collection ignores `<script>` / `<style>` and respects
 *    `data-find-skip`.
 *
 * Runs under happy-dom — no browser APIs beyond DOM are touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CHUNK_SIZE,
  type CompiledQuery,
  collectTextNodes,
  compileQuery,
  REGEX_NODE_MAX,
  REGEX_NODE_SCAN_MAX,
  REGEX_PATTERN_MAX,
  REGEX_TIME_BUDGET_MS,
  runWalker,
  walkSync,
} from '../matcher'

const defaultOpts = { caseSensitive: false, wholeWord: false, isRegex: false }

function makeHost(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

let attachedHosts: HTMLElement[] = []
afterEach(() => {
  for (const el of attachedHosts) el.remove()
  attachedHosts = []
})
beforeEach(() => {
  attachedHosts = []
})

function attach(html: string): HTMLDivElement {
  const host = makeHost(html)
  attachedHosts.push(host)
  return host
}

describe('compileQuery', () => {
  it('returns `empty` for an empty string', () => {
    expect(compileQuery('', defaultOpts).kind).toBe('empty')
  })

  it('literal mode is case-insensitive by default', () => {
    const compiled = compileQuery('ALPHA', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.kind).toBe('literal')
    expect(compiled.matcher('alpha bravo Alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 17 },
    ])
  })

  it('literal mode honours caseSensitive', () => {
    const compiled = compileQuery('Alpha', { ...defaultOpts, caseSensitive: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('alpha Alpha ALPHA')).toEqual([{ start: 6, end: 11 }])
  })

  it('literal mode surfaces overlapping matches', () => {
    const compiled = compileQuery('aa', defaultOpts) as Extract<CompiledQuery, { kind: 'literal' }>
    // "aaaa" contains 3 overlapping "aa" substrings (indices 0, 1, 2).
    expect(compiled.matcher('aaaa').map((m) => m.start)).toEqual([0, 1, 2])
  })

  it('wholeWord filters partial matches', () => {
    const compiled = compileQuery('cat', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // `cat` matches; `catalog` and `bobcat` do not.
    expect(compiled.matcher('cat catalog bobcat cat.')).toEqual([
      { start: 0, end: 3 },
      { start: 19, end: 22 },
    ])
  })

  it('regex compiles with case-insensitive flag by default', () => {
    const compiled = compileQuery('al\\w+', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    expect(compiled.kind).toBe('regex')
    expect(compiled.matcher('alpha ALPHA aleph')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ])
  })

  it('regex returns `error` on invalid pattern', () => {
    const compiled = compileQuery('[abc', { ...defaultOpts, isRegex: true })
    expect(compiled.kind).toBe('error')
  })

  it('regex enforces pattern length cap', () => {
    const huge = 'a'.repeat(REGEX_PATTERN_MAX + 1)
    const compiled = compileQuery(huge, { ...defaultOpts, isRegex: true })
    expect(compiled.kind).toBe('error')
    if (compiled.kind === 'error') {
      expect(compiled.message).toBe('findInPage.regexTooLong')
    }
  })

  it('regex zero-width matches do not loop forever', () => {
    const compiled = compileQuery('a*', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    // `a*` on `aaa` produces three real matches (a, aa, aaa-ish depending on
    // engine) — what matters is that the scanner terminates and emits at
    // least the leading `aaa` non-empty match.
    const out = compiled.matcher('aaa')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('compileQuery — Unicode correctness (#756)', () => {
  it('literal offsets stay aligned after a length-changing case fold (İ)', () => {
    const compiled = compileQuery('bravo', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // 'İ' (U+0130) lowercases to 'i' + U+0307 — two code units. Computing
    // indexOf offsets on the folded haystack used to shift every later
    // span by +1 per preceding 'İ' ("bravo" starts at 9 in the original
    // but at 10 in the folded string).
    expect(compiled.matcher('İstanbul bravo')).toEqual([{ start: 9, end: 14 }])
  })

  it('literal span covers the fold-expanding character itself', () => {
    // Needle typed with an explicit combining dot — folds identically to
    // the single-code-unit 'İ'. The original span is 8 units, not 9.
    const compiled = compileQuery('i̇stanbul', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('İstanbul')).toEqual([{ start: 0, end: 8 }])
  })

  it('case-sensitive literal mode is unaffected by fold expansion', () => {
    const compiled = compileQuery('bravo', { ...defaultOpts, caseSensitive: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(compiled.matcher('İstanbul bravo')).toEqual([{ start: 9, end: 14 }])
  })

  it('wholeWord treats non-Latin letters as word characters', () => {
    const compiled = compileQuery('мир', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // ASCII-only \w used to treat every Cyrillic letter as a boundary,
    // so "мир" also matched inside "мирный".
    expect(compiled.matcher('мир мирный')).toEqual([{ start: 0, end: 3 }])
  })

  it('wholeWord classifies astral-plane letters whole (surrogate pairs)', () => {
    const compiled = compileQuery('x', { ...defaultOpts, wholeWord: true }) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    // '𝐀' (U+1D400, MATHEMATICAL BOLD CAPITAL A) is a letter; an 'x'
    // glued to either side of it is not a whole word. Code-unit indexing
    // saw only an unpaired surrogate half and called it a boundary.
    expect(compiled.matcher('𝐀x y x')).toEqual([{ start: 6, end: 7 }])
    expect(compiled.matcher('x𝐀 x')).toEqual([{ start: 4, end: 5 }])
  })

  it('wholeWord regex post-filter uses the same Unicode word classes', () => {
    const compiled = compileQuery('мир', {
      ...defaultOpts,
      wholeWord: true,
      isRegex: true,
    }) as Extract<CompiledQuery, { kind: 'regex' }>
    expect(compiled.matcher('мир мирный')).toEqual([{ start: 0, end: 3 }])
  })
})

describe('walkSync', () => {
  it('collects matches across multiple text nodes', () => {
    const host = attach('<p>alpha bravo</p><p>charlie alpha delta</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]?.node.nodeValue).toBe('alpha bravo')
    expect(result.matches[1]?.node.nodeValue).toBe('charlie alpha delta')
  })

  it('matches do not span block boundaries', () => {
    // Locked-in edge case from the plan — same as VSCode.
    const host = attach('<p>end of paragraph 1</p><p>start of paragraph 2</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('paragraph 1 start', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    expect(walkSync(nodes, compiled).matches).toHaveLength(0)
  })

  it('skips >10 KB text nodes in regex mode and counts them', () => {
    const host = attach('<p></p><p>short</p>')
    const longText = 'x'.repeat(REGEX_NODE_MAX + 1)
    // Mutate the first paragraph's text node directly to bypass innerHTML
    // limits on large strings; happy-dom handles long Text values.
    const p = host.querySelector('p')
    p?.append(document.createTextNode(longText))

    const nodes = collectTextNodes(host)
    const compiled = compileQuery('x', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.skippedLongNodes).toBe(1)
    // The "short" node carries no `x`, so no matches collected.
    expect(result.matches).toHaveLength(0)
  })
})

describe('regex ReDoS / catastrophic-backtracking guard (#2030)', () => {
  // CRITICAL: a JS regex engine cannot be interrupted mid-`exec`. A
  // wall-clock check *between* nodes does NOT stop a single catastrophic
  // `exec` on one large node. So these tests must NEVER hand a real
  // pathological pattern a large enough input to actually hang — doing so
  // would freeze CI. Two independent guards are exercised here:
  //
  //   (a) per-node input cap (REGEX_NODE_SCAN_MAX) — bounds a single exec
  //       by slicing the node text before it ever reaches the engine, and
  //   (b) an aggregate wall-clock budget (REGEX_TIME_BUDGET_MS) checked at
  //       node boundaries to abort a long scan across many nodes.
  //
  // The budget tests below use an INJECTED clock so they are deterministic
  // and run exactly one (cheap, capped) exec — no test relies on a real
  // exponential exec completing.
  const EVIL_PATTERN = '(a+)+$'

  function makeNodes(text: string, count: number): Text[] {
    const host = attach('<p></p>')
    const p = host.querySelector('p')
    const nodes: Text[] = []
    for (let i = 0; i < count; i++) {
      const t = document.createTextNode(text)
      p?.append(t)
      nodes.push(t)
    }
    return nodes
  }

  it('caps per-node regex input at REGEX_NODE_SCAN_MAX so a single exec is bounded', () => {
    // A node well under REGEX_NODE_MAX (so it is NOT skipped) but longer
    // than REGEX_NODE_SCAN_MAX. Pattern `xyz$` would match only the tail
    // beyond the cap — proving the engine never saw past the cap. This runs
    // instantly because the slice handed to exec is bounded and `a*` is
    // linear, so the test can use a real (non-pathological) regex safely.
    const text = `${'a'.repeat(REGEX_NODE_SCAN_MAX + 500)}xyz`
    expect(text.length).toBeLessThan(REGEX_NODE_MAX) // not skipped as "long node"
    const nodes = makeNodes(text, 1)
    const compiled = compileQuery('xyz$', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    // The "xyz" lives beyond REGEX_NODE_SCAN_MAX, so the capped scan can't
    // see it: zero matches, and crucially the node was NOT skipped.
    expect(result.matches).toHaveLength(0)
    expect(result.skippedLongNodes).toBe(0)
    expect(result.timedOut).toBeFalsy()
  })

  it('matches within the scanned slice but not beyond the per-node cap', () => {
    const text = `${'before '.padEnd(10, ' ')}target${'z'.repeat(REGEX_NODE_SCAN_MAX)}target`
    const nodes = makeNodes(text, 1)
    const compiled = compileQuery('target', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    // First "target" is inside the slice; the second is pushed past the cap.
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.start).toBe(text.indexOf('target'))
  })

  it('aborts and flags timedOut when the regex scan exceeds the time budget', () => {
    // Deterministic via an injected clock: only one (capped, cheap) exec
    // runs before the budget trips at the next node boundary.
    const nodes = makeNodes(`${'a'.repeat(20)}!`, 5)
    const compiled = compileQuery(EVIL_PATTERN, { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    // `walkSync` calls now() once for `startedAt`, then once per node at the
    // boundary check. Calls 1 (start) and 2 (node 0) read 0 → under budget,
    // so node 0 runs; call 3 (node 1) reads past the budget → abort.
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }

    const result = walkSync(nodes, compiled, { timeBudgetMs: REGEX_TIME_BUDGET_MS, now })
    expect(result.timedOut).toBe(true)
    // Aborted at node 1, so only node 0's match (if any) was collected.
    expect(result.matches.length).toBeLessThan(5)
  })

  it('does not flag timedOut for a well-behaved regex within budget', () => {
    const host = attach('<p>alpha</p><p>beta</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha|beta', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >
    const result = walkSync(nodes, compiled)
    expect(result.timedOut).toBeFalsy()
    expect(result.matches).toHaveLength(2)
  })

  it('returns within a bounded time on a real pathological pattern (no hang)', () => {
    // No fake clock, REAL `(a+)+$` backtracking — but each node is only 20
    // chars of 'a', a few ms per exec, and the per-node cap guarantees no
    // single exec ever sees more than REGEX_NODE_SCAN_MAX chars. With a tiny
    // budget the walk aborts almost immediately. This proves the guard caps
    // wall-clock time WITHOUT ever running an unbounded exec.
    const nodes = makeNodes(`${'a'.repeat(20)}!`, 50)
    const compiled = compileQuery(EVIL_PATTERN, { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    const startedAt = Date.now()
    const result = walkSync(nodes, compiled, { timeBudgetMs: 1 })
    const elapsed = Date.now() - startedAt

    expect(result.timedOut).toBe(true)
    // Budget 1 ms + at most one in-flight (capped, ~few-ms) exec. A generous
    // ceiling that still proves the abort fired rather than running 50 nodes.
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('collectTextNodes', () => {
  it('ignores script and style elements', () => {
    const host = attach('<p>visible</p><script>hidden</script><style>.x{}</style>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('honours data-find-skip', () => {
    const host = attach('<p>visible</p><div data-find-skip><p>hidden</p></div>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })

  it('skips empty text nodes', () => {
    const host = attach('<p></p><p>visible</p>')
    expect(collectTextNodes(host).map((n) => n.nodeValue)).toEqual(['visible'])
  })
})

describe('runWalker', () => {
  it('emits onComplete with the full result for small docs', async () => {
    const host = attach('<p>alpha bravo</p><p>charlie alpha</p>')
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    const result = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, { onComplete: resolve })
    })
    expect(result.matches).toHaveLength(2)
  })

  it('chunks long docs and fires onProgress between chunks', async () => {
    // Build CHUNK_SIZE + 5 paragraphs each holding a match.
    const paragraphs = Array(CHUNK_SIZE + 5)
      .fill(null)
      .map(() => '<p>alpha</p>')
      .join('')
    const host = attach(paragraphs)
    const nodes = collectTextNodes(host)
    expect(nodes.length).toBeGreaterThan(CHUNK_SIZE)

    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >
    let progressCalls = 0
    const final = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(nodes, compiled, {
        onProgress: () => {
          progressCalls += 1
        },
        onComplete: resolve,
      })
    })
    expect(final.matches.length).toBe(nodes.length)
    expect(progressCalls).toBeGreaterThanOrEqual(1)
  })

  it('aborts an in-flight chunk on the ReDoS time budget and flags timedOut (#2030)', async () => {
    // A chunk full of pathological nodes would freeze the UI thread without
    // the guard. We prove the abort fires deterministically via an INJECTED
    // clock that trips the budget at the second node boundary — exactly one
    // (capped, cheap) exec runs, so the test never relies on a real
    // exponential exec completing and can never hang CI.
    const host = attach('<p></p>')
    const p = host.querySelector('p')
    const evil: Text[] = []
    for (let i = 0; i < 30; i++) {
      const t = document.createTextNode(`${'a'.repeat(20)}!`)
      p?.append(t)
      evil.push(t)
    }
    const compiled = compileQuery('(a+)+$', { ...defaultOpts, isRegex: true }) as Extract<
      CompiledQuery,
      { kind: 'regex' }
    >

    // First chunk: now() reads 0 for startedAt and node 0's check, then jumps
    // past the budget for node 1's check → abort with timedOut.
    let ticks = 0
    const now = () => {
      ticks += 1
      return ticks <= 2 ? 0 : REGEX_TIME_BUDGET_MS + 1
    }

    const final = await new Promise<ReturnType<typeof walkSync>>((resolve) => {
      runWalker(
        evil,
        compiled,
        { onComplete: resolve },
        { timeBudgetMs: REGEX_TIME_BUDGET_MS, now },
      )
    })

    expect(final.timedOut).toBe(true)
    expect(final.matches.length).toBeLessThan(evil.length)
  })

  it('cancellation aborts the walk', async () => {
    const paragraphs = Array(CHUNK_SIZE * 4)
      .fill(null)
      .map(() => '<p>alpha</p>')
      .join('')
    const host = attach(paragraphs)
    const nodes = collectTextNodes(host)
    const compiled = compileQuery('alpha', defaultOpts) as Extract<
      CompiledQuery,
      { kind: 'literal' }
    >

    let completed = false
    const handle = runWalker(nodes, compiled, {
      onComplete: () => {
        completed = true
      },
    })
    handle.cancel()
    // Give the scheduler enough idle ticks to drain.
    await new Promise((r) => setTimeout(r, 20))
    expect(completed).toBe(false)
  })
})
