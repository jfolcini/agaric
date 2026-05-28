import type React from 'react'

import type { BlockRefNode } from '../../../editor/types'
import { cn } from '../../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { RenderContext } from '../context'

function blockRefProps(
  refId: string,
  onNavigate: ((id: string) => void) | undefined,
  interactive: boolean | undefined,
): Record<string, unknown> {
  return {
    role: interactive === true ? 'link' : 'button',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      if (onNavigate) {
        e.stopPropagation()
        onNavigate(refId)
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && onNavigate) {
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
  return (
    <Tooltip key={key}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'block-ref-chip cursor-pointer',
            status === 'deleted' && 'block-ref-deleted',
          )}
          data-testid="block-ref-chip"
          {...deletedProps}
          {...blockRefProps(refId, ctx.onNavigate, ctx.interactive)}
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
