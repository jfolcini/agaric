import type React from 'react'

import type { BlockRefNode } from '../../../editor/types'
import { cn } from '../../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { RenderContext } from '../context'

/**
 * Build the event-handler + role props bundle for a clickable block-ref chip.
 * Mirrors `tagRefProps` / `blockLinkProps`: returns `{ role: 'link', tabIndex: 0,
 * onClick, onKeyDown }` with Enter + Space activation and `stopPropagation` on
 * every handler.
 *
 * Only spread when the chip is clickable (handler AND interactive). The caller
 * gates on both conditions, so this helper only ever produces the active bag.
 */
function blockRefProps(refId: string, onNavigate: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onNavigate(refId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(refId)
      }
    },
  }
}

export function renderBlockRef(
  node: BlockRefNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const refId = node.attrs.id
  const fullContent = ctx.resolveBlockTitle?.(refId) ?? `(( ${refId.slice(0, 8)}... ))`
  const status = ctx.resolveBlockStatus?.(refId) ?? 'active'
  const firstLine = fullContent.split('\n')[0] ?? fullContent
  const chipLabel = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
  const deletedProps = status === 'deleted' ? { 'aria-label': `${chipLabel} (deleted)` } : {}
  // Unified chip interactivity policy (matches tagRef / blockLink):
  // - clickable (handler AND interactive) → full affordances: role=link,
  //   tabIndex=0, key/click handlers, cursor-pointer.
  // - interactive but no handler → inert focus parity: tabIndex=0 only.
  // - not interactive → fully inert: no role, no tabIndex, no handlers, no
  //   cursor-pointer.
  const clickable = ctx.onNavigate !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? blockRefProps(refId, ctx.onNavigate as (id: string) => void)
    : inertProps
  return (
    <Tooltip key={key}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'block-ref-chip',
            clickable && 'cursor-pointer',
            status === 'deleted' && 'block-ref-deleted',
          )}
          data-testid="block-ref-chip"
          {...deletedProps}
          {...interactiveProps}
        >
          {chipLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
        {fullContent.length > 300 ? `${fullContent.slice(0, 297)}...` : fullContent}
      </TooltipContent>
    </Tooltip>
  )
}
