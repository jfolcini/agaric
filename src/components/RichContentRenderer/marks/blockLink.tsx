import type React from 'react'
import type { BlockLinkNode } from '../../../editor/types'
import { cn } from '../../../lib/utils'
import type { RenderContext } from '../context'

function blockLinkProps(
  linkId: string,
  onNavigate: ((id: string) => void) | undefined,
  interactive: boolean | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    role: 'link',
    onClick: (e: React.MouseEvent) => {
      if (onNavigate) {
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && onNavigate) {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
  }
  if (interactive === true) props['tabIndex'] = 0
  return props
}

export function renderBlockLink(
  node: BlockLinkNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const linkId = node.attrs.id
  const title = ctx.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
  const status = ctx.resolveBlockStatus?.(linkId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
  return (
    <span
      key={key}
      className={cn('block-link-chip cursor-pointer', status === 'deleted' && 'block-link-deleted')}
      data-testid="block-link-chip"
      {...deletedProps}
      {...blockLinkProps(linkId, ctx.onNavigate, ctx.interactive)}
    >
      {title}
    </span>
  )
}
