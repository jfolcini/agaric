/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from ADR-01.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 */

import type React from 'react'
import { parse } from '../editor/markdown-serializer'
import type { DocNode, InlineNode } from '../editor/types'

export interface StaticBlockProps {
  blockId: string
  content: string
  onFocus: (blockId: string) => void
  /** Called when the user clicks a block-link chip. */
  onNavigate?: (id: string) => void
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: (id: string) => string
  /** Resolve a tag ULID → display name. */
  resolveTagName?: (id: string) => string
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: (id: string) => 'active' | 'deleted'
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: (id: string) => 'active' | 'deleted'
}

/**
 * Render markdown content as rich React nodes for the static view.
 * Inline tokens (block_link, tag_ref) become styled/clickable spans.
 */
function renderRichContent(
  markdown: string,
  options: {
    onNavigate?: (id: string) => void
    resolveBlockTitle?: (id: string) => string
    resolveTagName?: (id: string) => string
    resolveBlockStatus?: (id: string) => 'active' | 'deleted'
    resolveTagStatus?: (id: string) => 'active' | 'deleted'
  },
): React.ReactNode {
  if (!markdown) return null
  const doc = parse(markdown) as DocNode
  if (!doc.content) return null

  const elements: React.ReactNode[] = []
  let keyIdx = 0

  for (let pIdx = 0; pIdx < doc.content.length; pIdx++) {
    const p = doc.content[pIdx]
    // Space separator between paragraphs (mirrors old renderPlainText join(' '))
    if (pIdx > 0) {
      elements.push(<span key={`sep-${keyIdx++}`}> </span>)
    }
    if (!p.content) continue

    for (const node of p.content as readonly InlineNode[]) {
      switch (node.type) {
        case 'text':
          elements.push(<span key={`t-${keyIdx++}`}>{node.text}</span>)
          break

        case 'tag_ref': {
          const tagId = node.attrs.id
          const name = options.resolveTagName?.(tagId) ?? `#${tagId.slice(0, 8)}...`
          const status = options.resolveTagStatus?.(tagId) ?? 'active'
          elements.push(
            <span
              key={`tag-${keyIdx++}`}
              className={`tag-ref-chip${status === 'deleted' ? ' tag-ref-deleted' : ''}`}
            >
              {name}
            </span>,
          )
          break
        }

        case 'block_link': {
          const linkId = node.attrs.id
          const title = options.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
          const status = options.resolveBlockStatus?.(linkId) ?? 'active'
          elements.push(
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled via TipTap editor when block is focused
            // biome-ignore lint/a11y/noStaticElementInteractions: inline chip within a button — parent handles focus/keyboard
            <span
              key={`link-${keyIdx++}`}
              className={`block-link-chip cursor-pointer${status === 'deleted' ? ' block-link-deleted' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                options.onNavigate?.(linkId)
              }}
            >
              {title}
            </span>,
          )
          break
        }

        case 'hardBreak':
          elements.push(<span key={`br-${keyIdx++}`}> </span>)
          break

        default:
          break
      }
    }
  }

  return <>{elements}</>
}

export function StaticBlock({
  blockId,
  content,
  onFocus,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
}: StaticBlockProps): React.ReactElement {
  return (
    <button
      type="button"
      className="block-static flex w-full cursor-text rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
      data-block-id={blockId}
      onClick={() => onFocus(blockId)}
    >
      {content ? (
        renderRichContent(content, {
          onNavigate,
          resolveBlockTitle,
          resolveTagName,
          resolveBlockStatus,
          resolveTagStatus,
        })
      ) : (
        <span className="block-placeholder text-muted-foreground italic">Empty block</span>
      )}
    </button>
  )
}
