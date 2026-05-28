import type React from 'react'

import type { BlockLinkNode } from '../../../editor/types'
import { getPageDisplayName } from '../../../lib/page-display'
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
  // PEND-83 Bug 1: inline `[[link]]` chip renders the LEAF only. The full
  // path stays available via the `title=""` tooltip — the chip lives inside
  // flowing text where a full namespaced path overflows the line.
  const { label } = getPageDisplayName(title, 'leaf')
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
  return (
    <span
      key={key}
      className={cn('block-link-chip cursor-pointer', status === 'deleted' && 'block-link-deleted')}
      data-testid="block-link-chip"
      title={title}
      {...deletedProps}
      {...blockLinkProps(linkId, ctx.onNavigate, ctx.interactive)}
    >
      {label}
    </span>
  )
}
