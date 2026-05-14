import type React from 'react'
import type { TagRefNode } from '../../../editor/types'
import { cn } from '../../../lib/utils'
import type { RenderContext } from '../context'

/**
 * Build the event-handler + role props bundle for a clickable tag chip.
 * Mirrors `blockLinkProps`: returns `{ role: 'link', tabIndex: 0, onClick,
 * onKeyDown }` with Enter + Space activation and `stopPropagation` on every
 * handler.
 *
 * When `onTagClick` is undefined or the surface is not interactive, the chip
 * must stay inert — the caller in `renderTagRef` gates on both conditions
 * before spreading this bundle, so this helper only produces the active bag.
 */
function tagRefProps(tagId: string, onTagClick: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onTagClick(tagId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onTagClick(tagId)
      }
    },
  }
}

export function renderTagRef(
  node: TagRefNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const tagId = node.attrs.id
  const name = ctx.resolveTagName?.(tagId) ?? `#${tagId.slice(0, 8)}...`
  const status = ctx.resolveTagStatus?.(tagId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${name} (deleted)` } : {}
  // Activate only when BOTH a handler AND an interactive surface are
  // supplied. When either is missing, fall back to today's inert render:
  // `tabIndex=0` for interactive focus parity, otherwise no props at all.
  // Deleted chips still fire the handler — it's useful for users to
  // discover the tag is gone.
  const clickable = ctx.onTagClick !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? tagRefProps(tagId, ctx.onTagClick as (id: string) => void)
    : inertProps
  return (
    <span
      key={key}
      className={cn(
        'tag-ref-chip',
        status === 'deleted' && 'tag-ref-deleted',
        clickable && 'cursor-pointer',
      )}
      data-testid="tag-ref-chip"
      {...deletedProps}
      {...interactiveProps}
    >
      {name}
    </span>
  )
}
