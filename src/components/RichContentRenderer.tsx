import type React from 'react'

import { parse } from '../editor/markdown-serializer'
import type { BlockLevelNode, DocNode } from '../editor/types'
import type { RenderContext } from './RichContentRenderer/context'
import { renderBlock, renderBlockInline } from './RichContentRenderer/marks/block'

// Re-export `CALLOUT_CONFIG` so existing imports keep working.
// (`{ CALLOUT_CONFIG, renderRichContent } from './RichContentRenderer'`)
export { CALLOUT_CONFIG } from './RichContentRenderer/context'

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
  const doc = parse(markdown) as DocNode
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
