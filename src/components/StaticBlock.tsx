/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from ADR-01.
 */

import type React from 'react'
import { parse } from '../editor/markdown-serializer'
import type { DocNode } from '../editor/types'

interface StaticBlockProps {
  blockId: string
  content: string
  onFocus: (blockId: string) => void
}

/**
 * Render markdown content as plain text for the static view.
 * Strips marks and resolves tokens to placeholders.
 */
function renderPlainText(markdown: string): string {
  if (!markdown) return ''
  const doc = parse(markdown) as DocNode
  if (!doc.content) return ''

  return doc.content
    .map((p) => {
      if (!p.content) return ''
      return p.content
        .map((node) => {
          switch (node.type) {
            case 'text':
              return node.text
            case 'tag_ref':
              return `#${node.attrs.id.slice(0, 8)}...`
            case 'block_link':
              return `[[${node.attrs.id.slice(0, 8)}...]]`
            case 'hardBreak':
              return ' '
            default:
              return ''
          }
        })
        .join('')
    })
    .join(' ')
}

export function StaticBlock({ blockId, content, onFocus }: StaticBlockProps): React.ReactElement {
  return (
    <button
      type="button"
      className="block-static flex w-full cursor-text rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
      data-block-id={blockId}
      onClick={() => onFocus(blockId)}
    >
      {content ? (
        renderPlainText(content)
      ) : (
        <span className="block-placeholder text-muted-foreground italic">Empty block</span>
      )}
    </button>
  )
}
