/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from ADR-01.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 */

import { toHtml } from 'hast-util-to-html'
import { common, createLowlight } from 'lowlight'
import type React from 'react'
import { parse } from '../editor/markdown-serializer'
import type { BlockLevelNode, DocNode, InlineNode } from '../editor/types'

const lowlight = createLowlight(common)

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
export function renderRichContent(
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

  /** Render inline content nodes into React elements. */
  function renderInline(content: readonly InlineNode[]) {
    for (const node of content) {
      switch (node.type) {
        case 'text': {
          const linkMark = node.marks?.find((m) => m.type === 'link')
          const hasBold = node.marks?.some((m) => m.type === 'bold') ?? false
          const hasItalic = node.marks?.some((m) => m.type === 'italic') ?? false
          const hasCode = node.marks?.some((m) => m.type === 'code') ?? false

          // Build the text content, wrapping with mark elements
          let content: React.ReactNode =
            linkMark && linkMark.type === 'link' ? (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled via TipTap editor when block is focused
              // biome-ignore lint/a11y/noStaticElementInteractions: inline link within a button — parent handles focus/keyboard
              <span
                className="external-link cursor-pointer"
                data-href={linkMark.attrs.href}
                onClick={(e) => {
                  e.stopPropagation()
                  window.open(linkMark.attrs.href, '_blank', 'noopener,noreferrer')
                }}
              >
                {node.text}
                <span className="sr-only"> (opens in new tab)</span>
                <span className="inline-block ml-0.5 text-[0.7em] opacity-60" aria-hidden="true">
                  ↗
                </span>
              </span>
            ) : (
              node.text
            )

          // Apply marks from innermost to outermost
          if (hasCode)
            content = (
              <code className="bg-muted rounded px-1 py-0.5 text-[0.85em] font-mono">
                {content}
              </code>
            )
          if (hasItalic) content = <em>{content}</em>
          if (hasBold) content = <strong>{content}</strong>

          elements.push(<span key={`t-${keyIdx++}`}>{content}</span>)
          break
        }

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

  for (let bIdx = 0; bIdx < doc.content.length; bIdx++) {
    const block = doc.content[bIdx] as BlockLevelNode
    // Space separator between blocks
    if (bIdx > 0) {
      elements.push(<span key={`sep-${keyIdx++}`}> </span>)
    }

    if (block.type === 'heading') {
      const HeadingTag = `h${block.attrs.level}` as keyof JSX.IntrinsicElements
      const headingClasses: Record<number, string> = {
        1: 'text-2xl font-bold',
        2: 'text-xl font-bold',
        3: 'text-lg font-semibold',
        4: 'text-base font-semibold',
        5: 'text-sm font-semibold',
        6: 'text-xs font-semibold uppercase tracking-wide',
      }
      const cls = headingClasses[block.attrs.level] ?? ''
      const startIdx = keyIdx++
      const inlineElements: React.ReactNode[] = []
      if (block.content) {
        const prevLen = elements.length
        renderInline(block.content)
        inlineElements.push(...elements.splice(prevLen))
      }
      elements.push(
        <HeadingTag key={`h-${startIdx}`} className={cls}>
          {inlineElements}
        </HeadingTag>,
      )
    } else if (block.type === 'codeBlock') {
      const code = block.content?.[0]?.text ?? ''
      const language = block.attrs?.language ?? ''
      let highlighted: string
      try {
        const tree = language ? lowlight.highlight(language, code) : lowlight.highlightAuto(code)
        highlighted = toHtml(tree)
      } catch {
        highlighted = code
      }
      elements.push(
        <pre
          key={`code-${keyIdx++}`}
          className="bg-muted rounded-md px-3 py-2 text-sm font-mono overflow-x-auto"
        >
          <code
            className={language ? `language-${language} hljs` : 'hljs'}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: lowlight output is safe
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>,
      )
    } else {
      // paragraph
      if (!block.content) continue
      renderInline(block.content as readonly InlineNode[])
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
      className="block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      data-block-id={blockId}
      aria-label="Edit block"
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
