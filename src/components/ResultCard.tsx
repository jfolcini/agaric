/**
 * ResultCard — shared card button for displaying a block result.
 *
 * Used by SearchPanel and TagFilterPanel to render identical result cards
 * with optional spinner, badge, and child content (e.g. breadcrumbs).
 */

import type React from 'react'
import { Badge } from '@/components/ui/badge'
import { CardButton } from '@/components/ui/card-button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../lib/tauri'

export interface ResultCardProps {
  block: BlockRow
  onClick: () => void
  disabled?: boolean
  /** Extra content below the main line (e.g., breadcrumb). */
  children?: React.ReactNode
  /** Show a loading spinner on the right side */
  showSpinner?: boolean
  /** CSS class name for the content span */
  contentClassName?: string
}

export function ResultCard({
  block,
  onClick,
  disabled,
  children,
  showSpinner,
  contentClassName,
}: ResultCardProps): React.ReactElement {
  return (
    <CardButton onClick={onClick} disabled={disabled}>
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 text-sm', contentClassName)}>{block.content || '(empty)'}</span>
        {showSpinner && <Spinner className="shrink-0 text-muted-foreground" />}
        {(block.block_type === 'tag' || block.block_type === 'page') && (
          <Badge variant="secondary">{block.block_type}</Badge>
        )}
      </div>
      {children}
    </CardButton>
  )
}
