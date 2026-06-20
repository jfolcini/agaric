import type React from 'react'

import type { BlockLinkNode } from '../../../editor/types'
import { getPageDisplayName } from '../../../lib/page-display'
import { cn } from '../../../lib/utils'
import type { RenderContext } from '../context'

/**
 * Build the event-handler + role props bundle for a clickable block-link chip.
 * Mirrors `tagRefProps` / `blockRefProps`: returns `{ role: 'link', tabIndex: 0,
 * onClick, onKeyDown }` with Enter + Space activation and `stopPropagation` on
 * every handler.
 *
 * Only spread when the chip is clickable (handler AND interactive). The caller
 * gates on both conditions, so this helper only ever produces the active bag.
 */
function blockLinkProps(linkId: string, onNavigate: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onNavigate(linkId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
  }
}

export function renderBlockLink(
  node: BlockLinkNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const linkId = node.attrs.id
  const title = ctx.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
  const status = ctx.resolveBlockStatus?.(linkId) ?? 'active'
  // Bug 1: inline `[[link]]` chip renders the LEAF only. The full
  // path stays available via the `title=""` tooltip — the chip lives inside
  // flowing text where a full namespaced path overflows the line.
  const { label } = getPageDisplayName(title, 'leaf')
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
  // Unified chip interactivity policy (matches tagRef / blockRef):
  // - clickable (handler AND interactive) → full affordances: role=link,
  //   tabIndex=0, key/click handlers, cursor-pointer.
  // - interactive but no handler → inert focus parity: tabIndex=0 only.
  // - not interactive → fully inert: no role, no tabIndex, no handlers, no
  //   cursor-pointer.
  const clickable = ctx.onNavigate !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? blockLinkProps(linkId, ctx.onNavigate as (id: string) => void)
    : inertProps
  return (
    <span
      key={key}
      className={cn(
        'block-link-chip',
        clickable && 'cursor-pointer',
        status === 'deleted' && 'block-link-deleted',
      )}
      data-testid="block-link-chip"
      title={title}
      {...deletedProps}
      {...interactiveProps}
    >
      {label}
    </span>
  )
}
