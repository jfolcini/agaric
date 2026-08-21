import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { BlockRefNode } from '@/editor/types'
import { cn } from '@/lib/utils'

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
  // #4228 — the resolve store already holds the normalised, display-ready
  // title (first line, capped, Untitled-substituted — see
  // `normalizeBlockRefTitle` in `@/lib/block-title`), applied once at every
  // seed call site. Render it verbatim: no per-renderer split/cap here to
  // disagree with the seed or with the TipTap `BlockRef` NodeView
  // (`@/editor/extensions/block-ref.ts`), which renders the same value the
  // same way.
  const title = ctx.resolveBlockTitle?.(refId) ?? `(( ${refId.slice(0, 8)}... ))`
  const status = ctx.resolveBlockStatus?.(refId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
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
          {title}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
        {title}
      </TooltipContent>
    </Tooltip>
  )
}
