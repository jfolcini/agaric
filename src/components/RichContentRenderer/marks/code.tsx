import type React from 'react'
import { Fragment, useEffect, useState } from 'react'

import { renderMermaidBlock } from '@/components/RichContentRenderer/marks/mermaid'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { CodeBlockNode } from '@/editor/types'

// #2939 — `curatedLowlight` bundles highlight.js grammars (~51 kB chunk). It is
// imported DYNAMICALLY inside the idle-time highlight upgrade below, not
// statically, so the grammars stay off the cold-start path. First paint already
// renders plain text and upgrades to highlighted output post-commit, so folding
// the chunk load into that same deferred step is invisible. Type-only import of
// the instance's shape keeps the module TipTap/highlight-free at startup.
type CuratedLowlight = (typeof import('@/lib/lowlight-curated'))['curatedLowlight']

// ============================================================================
// Hast → React (syntax-highlighted code blocks, avoids innerHTML)
// ============================================================================

interface HastTextNode {
  readonly type: 'text'
  readonly value: string
}
interface HastElementNode {
  readonly type: 'element'
  readonly tagName: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly children: readonly HastChildNode[]
}
interface HastRootNode {
  readonly type: 'root'
  readonly children: readonly HastChildNode[]
}
type HastChildNode = HastTextNode | HastElementNode

function hastClassName(
  properties: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const cls = properties?.['className']
  if (Array.isArray(cls)) {
    return cls.filter((c): c is string => typeof c === 'string').join(' ')
  }
  if (typeof cls === 'string') return cls
  return undefined
}

function hastChildrenToReact(
  children: readonly HastChildNode[],
  keyPrefix: string,
): React.ReactNode[] {
  return children.map((child, i) => {
    const childKey = `${keyPrefix}-${i}`
    if (child.type === 'text') {
      return <Fragment key={childKey}>{child.value}</Fragment>
    }
    return (
      <span key={childKey} className={hastClassName(child.properties)}>
        {hastChildrenToReact(child.children, childKey)}
      </span>
    )
  })
}

/**
 * Highlighting cap (#747 item 3). `highlightAuto` scans the source across every
 * registered grammar with backtracking regexes — O(grammars × length) work — so
 * a pasted multi-hundred-KB log would stall the render thread. Above this cap we
 * render the code as plain text (no highlighting) — still fully readable, just
 * uncolored.
 */
export const HIGHLIGHT_MAX_LENGTH = 30_000

// ============================================================================
// Highlight-output cache + deferred highlighting (#2271)
// ============================================================================
//
// `lowlight.highlight` / `highlightAuto` are the single most expensive step in
// rendering a viewport of code blocks: `highlightAuto` alone backtracks across
// ~16 grammars. Two layers keep that off the critical path:
//
//   1. A bounded module-level LRU keyed on `(language ?? 'auto', code)` caches
//      the produced HAST tree (or `null` for "known plain": over-cap or a
//      highlighter error). Identical blocks and re-renders never re-scan — an
//      O(1) lookup replaces the grammar walk. We cache the HAST (not the React
//      nodes) so the cheap HAST→React conversion can re-key per call site,
//      keeping React keys correct regardless of which block reuses the entry.
//
//   2. `HighlightedCode` renders plain `<code>` text on first paint and upgrades
//      to highlighted output post-commit (requestIdleCallback, setTimeout
//      fallback). A synchronous cache hit skips the defer entirely and paints
//      highlighted immediately (no flicker on re-render / scroll-back).
//
// The cached HAST is treated as immutable: `hastChildrenToReact` only reads it.

const HIGHLIGHT_CACHE_MAX = 300

/**
 * Byte ceiling for the highlight cache (#2289). The entry cap alone
 * (`HIGHLIGHT_CACHE_MAX`) bounds the *count* of entries but not their *size*:
 * each entry may hold the HAST tree for a code block up to
 * `HIGHLIGHT_MAX_LENGTH` (30 000) chars, so 300 large entries could
 * theoretically accumulate tens of MB of retained tree nodes.
 *
 * We add a second, byte-based bound. The per-entry cost is estimated by a cheap
 * PROXY computed at write time: the source `code` string's `.length`. That is a
 * lower bound on — and correlates with — the produced HAST size (every source
 * char reappears in some text node, plus per-token element overhead) and needs
 * no tree walk. The proxy is stored per entry so eviction can subtract it
 * without recomputing.
 *
 * The value below is a conservative SAFETY CEILING, not a measured optimum:
 * ~4 MB of accumulated proxy-bytes. Because the proxy under-counts the true HAST
 * footprint (element wrappers, class strings, per-object overhead), real
 * retained memory is a small multiple of this — the point is a hard upper bound
 * in the low-single-digit-MB range regardless of individual entry sizes, which
 * the count cap alone cannot guarantee.
 */
const HIGHLIGHT_CACHE_MAX_BYTES = 4 * 1024 * 1024

interface HighlightCacheEntry {
  readonly tree: HastRootNode | null
  /** Cheap proxy for this entry's memory cost: the source `code.length`. */
  readonly bytes: number
}

const highlightCache = new Map<string, HighlightCacheEntry>()
// Running sum of every live entry's `bytes` proxy. Kept in lock-step with the
// map on every insert / eviction / recency-refresh / clear.
let cacheBytes = 0

function highlightCacheKey(code: string, language: string): string {
  // NUL separator can't appear in a language identifier, so the join is
  // unambiguous ("l:js\0x" can only come from language "js", code "x"). The
  // explicit-language namespace is `l:`-prefixed so a literal language string
  // "auto" (bogus — highlights to null) can never collide with, and poison,
  // the auto-detect entry for the same code.
  return `${language ? `l:${language}` : 'auto'}\u0000${code}`
}

/**
 * Non-mutating cache peek used by the render-phase `useState` initializer.
 * Returns the cached HAST tree, `null` for a cached "known plain" block, or
 * `undefined` when the block has never been highlighted (a miss). We never
 * store `undefined`, so `undefined` unambiguously means "not cached".
 */
// Exported for tests (byte-budget assertions drive the cache directly). Safe to
// call in production too; the render path already uses it.
export function peekHighlightCache(
  code: string,
  language: string,
): HastRootNode | null | undefined {
  const k = highlightCacheKey(code, language)
  const entry = highlightCache.get(k)
  return entry === undefined ? undefined : entry.tree
}

// Exported for tests (see peekHighlightCache note).
export function writeHighlightCache(
  code: string,
  language: string,
  tree: HastRootNode | null,
): void {
  const k = highlightCacheKey(code, language)
  // Cheap write-time proxy for this entry's cost — see HIGHLIGHT_CACHE_MAX_BYTES.
  // Used consistently for highlighted AND "known plain" (null) entries.
  const newBytes = code.length

  // Recency refresh: if the key already exists, drop it (and its byte cost)
  // first so the re-insert below moves it to the most-recent position and the
  // accounting reflects only the new estimate.
  const existing = highlightCache.get(k)
  if (existing !== undefined) {
    cacheBytes -= existing.bytes
    highlightCache.delete(k)
  }

  // Evict oldest entries (Map insertion order = oldest first) until BOTH bounds
  // admit the newcomer: entry count < cap AND accumulated bytes + newBytes <=
  // byte ceiling. Guard on a non-empty map so a single entry larger than the
  // whole byte budget is still admitted, and we never loop forever on an empty
  // map.
  while (
    highlightCache.size > 0 &&
    (highlightCache.size >= HIGHLIGHT_CACHE_MAX ||
      cacheBytes + newBytes > HIGHLIGHT_CACHE_MAX_BYTES)
  ) {
    const oldestKey = highlightCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = highlightCache.get(oldestKey)
    if (oldest !== undefined) cacheBytes -= oldest.bytes
    highlightCache.delete(oldestKey)
  }

  highlightCache.set(k, { tree, bytes: newBytes })
  cacheBytes += newBytes
}

/**
 * Clear the module-level highlight cache. Intended for test isolation so a
 * prior test's cached tree (which would paint highlighted synchronously) does
 * not mask an assertion about the deferred-upgrade path.
 */
export function clearHighlightCache(): void {
  highlightCache.clear()
  cacheBytes = 0
}

/**
 * TEST-ONLY accessor for the cache accounting so byte-budget eviction can be
 * asserted without reaching into module internals. Not used in production.
 */
export function __highlightCacheStats(): { entries: number; bytes: number } {
  return { entries: highlightCache.size, bytes: cacheBytes }
}

/**
 * Run the (expensive) highlighter. Returns the HAST tree, or `null` when the
 * block is over the cap or the highlighter throws (fall back to plain text).
 */
function computeHighlight(
  lowlight: CuratedLowlight,
  code: string,
  language: string,
): HastRootNode | null {
  if (code.length > HIGHLIGHT_MAX_LENGTH) return null
  try {
    return (language
      ? lowlight.highlight(language, code)
      : lowlight.highlightAuto(code)) as unknown as HastRootNode
  } catch {
    return null
  }
}

/**
 * Schedule `cb` off the critical path. Prefers `requestIdleCallback`; falls back
 * to `setTimeout` where it is unavailable (jsdom/SSR). Returns a disposer.
 */
function scheduleIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(cb)
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id)
    }
  }
  const id = setTimeout(cb, 0)
  return () => clearTimeout(id)
}

interface HighlightedCodeProps {
  readonly code: string
  readonly language: string
  readonly keyPrefix: string
}

/**
 * Syntax-highlighted code content (#2271). A component (not a plain helper) so
 * hooks are legal: a synchronous cache hit paints its final form immediately;
 * a miss paints plain text and upgrades after commit.
 */
function HighlightedCode({ code, language, keyPrefix }: HighlightedCodeProps): React.ReactElement {
  // `tree: undefined` → not yet highlighted (miss, defer); `HastRootNode` →
  // cached highlighted; `null` → cached "known plain" (over cap / error).
  //
  // The state carries the `(code, language)` it was computed FOR. React keys
  // for code blocks are positional (`b-${bIdx}`), so this component instance
  // can be REUSED with different props — an edited code block, or a sibling
  // deletion shifting a different code block into this slot. A bare
  // `useState(tree)` would keep rendering the PREVIOUS code's tree forever
  // (the effect's `tree !== undefined` early-return never recomputes).
  // Render-phase reset (React's derive-state-from-props idiom: React discards
  // the mismatched pass and re-renders before commit) re-peeks the cache for
  // the new props so the committed output always matches `code`.
  const [state, setState] = useState<{
    code: string
    language: string
    tree: HastRootNode | null | undefined
  }>(() => ({ code, language, tree: peekHighlightCache(code, language) }))
  if (state.code !== code || state.language !== language) {
    setState({ code, language, tree: peekHighlightCache(code, language) })
  }
  const tree = state.tree

  useEffect(() => {
    // Already resolved (cache hit at mount, or a prior effect upgraded us):
    // nothing to schedule.
    if (tree !== undefined) return undefined
    let cancelled = false
    const cancel = scheduleIdle(() => {
      if (cancelled) return
      // #2939 — load the highlight.js grammars lazily (off the cold-start path)
      // as part of this deferred upgrade. On import failure fall back to
      // known-plain so we don't re-schedule every render.
      void import('@/lib/lowlight-curated')
        .then(({ curatedLowlight }) => {
          if (cancelled) return
          const result = computeHighlight(curatedLowlight, code, language)
          writeHighlightCache(code, language, result)
          setState({ code, language, tree: result })
        })
        .catch(() => {
          if (cancelled) return
          writeHighlightCache(code, language, null)
          setState({ code, language, tree: null })
        })
    })
    return () => {
      cancelled = true
      cancel()
    }
  }, [code, language, tree])

  if (tree) {
    return <>{hastChildrenToReact(tree.children, keyPrefix)}</>
  }
  // Miss-in-progress or known-plain: readable plain text (just uncolored).
  return <>{code}</>
}

export function renderCodeBlock(block: CodeBlockNode, key: string): React.ReactElement {
  const code = block.content?.[0]?.text ?? ''
  const language = block.attrs?.language ?? ''
  if (language === 'mermaid') return renderMermaidBlock(code, key)
  return (
    <ScrollArea key={key} className="bg-muted rounded-md text-sm font-mono">
      <pre className="px-3 py-2">
        <code className={language ? `language-${language} hljs` : 'hljs'}>
          <HighlightedCode code={code} language={language} keyPrefix={`${key}-code`} />
        </code>
      </pre>
    </ScrollArea>
  )
}
