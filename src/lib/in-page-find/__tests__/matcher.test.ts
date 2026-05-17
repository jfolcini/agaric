/**
 * Unit tests for the in-page find matcher (PEND-52).
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
  REGEX_PATTERN_MAX,
  runWalker,
  walkSync,
} from '../matcher'

const defaultOpts = { caseSensitive: false, wholeWord: false, isRegex: false }

function makeHost(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
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
    p?.appendChild(document.createTextNode(longText))

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
