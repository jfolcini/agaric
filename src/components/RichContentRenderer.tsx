import type React from 'react'

import { parse } from '../editor/markdown-serializer'
import type { BlockLevelNode, DocNode } from '../editor/types'
import type { RenderContext } from './RichContentRenderer/context'
import { renderBlock, renderBlockInline } from './RichContentRenderer/marks/block'

// Re-export `CALLOUT_CONFIG` so existing imports keep working.
// (`{ CALLOUT_CONFIG, renderRichContent } from './RichContentRenderer'`)
export { CALLOUT_CONFIG } from './RichContentRenderer/context'

/**
 * Bounded LRU cache for the pure `parse(markdown)` step.
 *
 * `parse` is a pure function of the markdown string alone: the top-level
 * caller always invokes it with the default `depth = 0`, and the render
 * `options` (resolve callbacks, `interactive`, `inline`, …) only feed the
 * downstream RENDER pass — they never touch `parse`. So the produced
 * `DocNode` is fully determined by the markdown string and safe to memoize on
 * that key. (Mirrors the single-entry `parseMemoized` in `use-roving-editor`.)
 *
 * Backlink / diff / agenda list views re-render on every keystroke or
 * arrow-key focus change, re-running `parse` for every visible row. This cache
 * turns those repeat parses of unchanged content into O(1) lookups.
 *
 * The render pass only READS the cached `DocNode` (walking `.content` to build
 * fresh React elements); it never mutates it, so sharing the node across calls
 * is safe. Recency is refreshed on read (delete + re-set), and the oldest
 * entry is evicted once the cache is full — `Map` preserves insertion order,
 * so `keys().next()` yields the oldest.
 */
const PARSE_CACHE_MAX = 300
const parseCache = new Map<string, DocNode>()

function parseCached(markdown: string): DocNode {
  const hit = parseCache.get(markdown)
  if (hit !== undefined) {
    // Refresh recency: re-insert so this key becomes the most recent.
    parseCache.delete(markdown)
    parseCache.set(markdown, hit)
    return hit
  }
  const doc = parse(markdown) as DocNode
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(markdown, doc)
  return doc
}

/**
 * Clear the module-level parse cache. Intended for test isolation — tests that
 * spy on `parse` and assert its call count must flush the cache in `beforeEach`
 * so a prior test's cached entry doesn't suppress an expected parse.
 */
export function clearRichContentParseCache(): void {
  parseCache.clear()
}

/**
 * Render markdown content as rich React nodes for the static view.
 * Inline tokens (block_link, tag_ref) become styled/clickable spans.
 *
 * This dispatcher is intentionally thin: it parses markdown into a DocNode
 * and delegates each block to a per-type renderer under
 * `./RichContentRenderer/marks/`. See `./RichContentRenderer/context.ts`
 * for the shared `RenderContext` and callout/heading lookup tables.
 */
export function renderRichContent(
  markdown: string,
  options: {
    onNavigate?: ((id: string) => void) | undefined
    onTagClick?: ((id: string) => void) | undefined
    resolveBlockTitle?: ((id: string) => string | undefined) | undefined
    resolveTagName?: ((id: string) => string | undefined) | undefined
    resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
    resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
    interactive?: boolean | undefined
    /**
     * Preview/inline-only mode (#1533). When true, block-level nodes are
     * downgraded to inline text (no <h*>, <ol>/<ul>, <table>, <pre>,
     * <blockquote> or <div>) so the result is safe to place inside an inline
     * wrapper such as a clamping <span> (HistoryItemCore) or a <p>
     * (DiffDisplay). Default (omitted/false) leaves at-rest full-document
     * rendering byte-identical for the editor/static-view callers.
     */
    inline?: boolean | undefined
  },
): React.ReactNode {
  if (!markdown) return null
  const doc = parseCached(markdown)
  if (!doc.content) return null

  const inline = options.inline ?? false
  const elements: React.ReactNode[] = []
  const ctx: RenderContext = options
  for (let bIdx = 0; bIdx < doc.content.length; bIdx++) {
    const block = doc.content[bIdx] as BlockLevelNode
    if (inline) {
      const inlineNodes = renderBlockInline(block, `b-${bIdx}`, ctx)
      if (inlineNodes.length === 0) continue
      // Separator before this block's content, but only once we've already
      // emitted something — keeps previews from starting with a stray space.
      if (elements.length > 0) {
        elements.push(<span key={`sep-${bIdx}`}> </span>)
      }
      elements.push(...inlineNodes)
      continue
    }
    // Space separator between blocks
    if (bIdx > 0) {
      elements.push(<span key={`sep-${bIdx}`}> </span>)
    }
    const rendered = renderBlock(block, `b-${bIdx}`, ctx)
    if (Array.isArray(rendered)) {
      elements.push(...rendered)
    } else if (rendered !== null) {
      elements.push(rendered)
    }
  }

  return <>{elements}</>
}
