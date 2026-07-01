import type React from 'react'
import { Fragment, useEffect, useState } from 'react'

import type { CodeBlockNode } from '../../../editor/types'
import { curatedLowlight } from '../../../lib/lowlight-curated'
import { ScrollArea } from '../../ui/scroll-area'
import { renderMermaidBlock } from './mermaid'

// `curatedLowlight` shared instance (see `src/lib/lowlight-curated.ts`).
// Aliased locally so the existing `lowlight.highlight(...)` call-sites below
// keep their concise form and we avoid touching unrelated lines.
const lowlight = curatedLowlight

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
const highlightCache = new Map<string, HastRootNode | null>()

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
function peekHighlightCache(code: string, language: string): HastRootNode | null | undefined {
  const k = highlightCacheKey(code, language)
  return highlightCache.has(k) ? highlightCache.get(k) : undefined
}

function writeHighlightCache(code: string, language: string, tree: HastRootNode | null): void {
  const k = highlightCacheKey(code, language)
  if (!highlightCache.has(k) && highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    // `Map` preserves insertion order, so the first key is the oldest.
    const oldest = highlightCache.keys().next().value
    if (oldest !== undefined) highlightCache.delete(oldest)
  }
  // delete + set refreshes recency (moves the key to the most-recent position).
  highlightCache.delete(k)
  highlightCache.set(k, tree)
}

/**
 * Clear the module-level highlight cache. Intended for test isolation so a
 * prior test's cached tree (which would paint highlighted synchronously) does
 * not mask an assertion about the deferred-upgrade path.
 */
export function clearHighlightCache(): void {
  highlightCache.clear()
}

/**
 * Run the (expensive) highlighter. Returns the HAST tree, or `null` when the
 * block is over the cap or the highlighter throws (fall back to plain text).
 */
function computeHighlight(code: string, language: string): HastRootNode | null {
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
      const result = computeHighlight(code, language)
      writeHighlightCache(code, language, result)
      setState({ code, language, tree: result })
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
